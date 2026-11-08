// Serveur Passerelle : taux de change en direct + fichiers de l'application.
// Aucune dépendance. Node 18 ou plus.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { providerFor } = require('./providers');

const PORT = process.env.PORT || 3000;
const TTL = 10 * 60 * 1000; // taux rafraîchis toutes les 10 minutes

// Parités fixes officielles (pour 1 EUR)
const FIXES = { EUR: 1, XOF: 655.957, XAF: 655.957, KMF: 491.96775, CVE: 110.265, STN: 24.5, BAM: 1.95583 };

let cache = null;

async function lireBCE() {
  const r = await fetch('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
  if (!r.ok) throw new Error('BCE ' + r.status);
  const xml = await r.text();
  const rates = {};
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) rates[m[1]] = parseFloat(m[2]);
  const d = xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/);
  return { rates, date: d ? d[1] : null };
}

async function lireMarche() {
  const r = await fetch('https://open.er-api.com/v6/latest/EUR');
  if (!r.ok) throw new Error('er-api ' + r.status);
  const j = await r.json();
  if (!j.rates) throw new Error('er-api vide');
  return j.rates;
}

async function rafraichir() {
  const [bce, marche] = await Promise.allSettled([lireBCE(), lireMarche()]);
  if (bce.status === 'rejected' && marche.status === 'rejected') throw new Error('aucune source disponible');
  // Priorité : parités fixes > BCE > marché
  const rates = Object.assign({}, marche.value || {}, bce.value ? bce.value.rates : {}, FIXES);
  cache = {
    base: 'EUR',
    updated: new Date().toISOString(),
    sources: { bce: bce.status === 'fulfilled' ? bce.value.date : null, marche: marche.status === 'fulfilled' },
    rates, at: Date.now(), stale: false
  };
  return cache;
}

async function taux() {
  if (cache && Date.now() - cache.at < TTL) return cache;
  try { return await rafraichir(); }
  catch (e) { if (cache) { cache.stale = true; return cache; } throw e; }
}


// ---------- Envois (mode test par défaut) ----------
const DEVISES_DEPART = ['XOF', 'EUR', 'USD'];
const MOBILE = ['Wave', 'Orange Money', 'MTN MoMo', 'Moov Money'];
const FRAIS_DEPOT = { 'Carte bancaire': 0.015, 'Virement bancaire': 0, 'Wave': 0.005, 'Orange Money': 0.005, 'MTN MoMo': 0.005, 'Moov Money': 0.005, 'Dépôt en agence': 0 };
const FRAIS_RETRAIT = { 'Wave': 0.01, 'Orange Money': 0.01, 'MTN MoMo': 0.01, 'Moov Money': 0.01, 'Virement bancaire': 0.005, 'Retrait en agence': 0.015 };
const MAX_EUR = 5000; // plafond de démonstration par envoi, en équivalent euros
const transferts = new Map();   // id -> envoi (en mémoire : à remplacer par une base de données)
const cles = new Map();         // clé d'idempotence -> id
const compteurs = new Map();    // limitation de débit par IP

function limite(ip) {
  const now = Date.now(), m = compteurs.get(ip) || { n: 0, t: now };
  if (now - m.t > 60000) { m.n = 0; m.t = now; }
  m.n++; compteurs.set(ip, m);
  return m.n > 30;
}

function devis(rates, from, to, amount) {
  const r = rates[to] / rates[from];
  const frais = Math.round((amount * 0.009 + rates[from]) * 100) / 100; // 0,9 % + équivalent de 1 €
  return { rate: r, fee: frais, total: amount + frais, received: amount * r };
}

function corps(req) {
  return new Promise((ok, ko) => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 20000) { ko(new Error('trop gros')); req.destroy(); } });
    req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { ko(e); } });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function public_(t) {
  return { ref: t.ref, status: t.status, reason: t.reason || null, from: t.from, to: t.to, amount: t.amount,
           type: t.type || 'transfer', fee: t.fee, total: t.total, received: t.received, country: t.country, method: t.method, createdAt: t.createdAt };
}

async function api(req, res, url) {
  const ip = req.socket.remoteAddress || 'x';
  if (limite(ip)) return json(res, 429, { error: 'Trop de requêtes, réessayez dans une minute.' });
  const c = await taux();

  if (req.method === 'GET' && url.pathname === '/api/quote') {
    const from = url.searchParams.get('from'), to = url.searchParams.get('to'), a = parseFloat(url.searchParams.get('amount'));
    if (!DEVISES_DEPART.includes(from) || !c.rates[to] || !(a > 0)) return json(res, 400, { error: 'Paramètres invalides.' });
    return json(res, 200, devis(c.rates, from, to, a));
  }

  if (req.method === 'POST' && url.pathname === '/api/transfers') {
    let b; try { b = await corps(req); } catch (e) { return json(res, 400, { error: 'Requête illisible.' }); }
    const a = Number(b.amount), name = String(b.name || '').trim(), account = String(b.account || '').trim();
    if (!DEVISES_DEPART.includes(b.from) || !c.rates[b.to] || !(a > 0)) return json(res, 400, { error: 'Montant ou devise invalide.' });
    if (name.length < 2 || name.length > 80 || account.length < 6 || account.length > 60) return json(res, 400, { error: 'Bénéficiaire invalide.' });
    if (a / c.rates[b.from] > MAX_EUR) return json(res, 400, { error: 'Montant au-dessus du plafond de ' + MAX_EUR + ' €.' });
    if (b.key && cles.has(b.key)) return json(res, 200, public_(transferts.get(cles.get(b.key)))); // même clé = même envoi, pas de doublon
    const q = devis(c.rates, b.from, b.to, a);
    const t = { id: crypto.randomUUID(), ref: 'PSG-' + crypto.randomBytes(3).toString('hex').toUpperCase(), from: b.from, to: b.to,
      amount: a, fee: q.fee, total: q.total, received: q.received, country: String(b.country || ''), method: String(b.method || ''),
      name, account, status: 'processing', createdAt: Date.now() };
    try {
      const r = await providerFor(t).send(t);
      t.status = r.status; t.providerRef = r.providerRef; t.reason = r.reason;
    } catch (e) { return json(res, 502, { error: 'Le prestataire est indisponible, réessayez.' }); }
    transferts.set(t.id, t); transferts.set(t.ref, t);
    if (b.key) cles.set(b.key, t.id);
    return json(res, 201, public_(t));
  }


  if (req.method === 'POST' && (url.pathname === '/api/deposits' || url.pathname === '/api/withdrawals')) {
    const dep = url.pathname === '/api/deposits';
    let b; try { b = await corps(req); } catch (e) { return json(res, 400, { error: 'Requête illisible.' }); }
    const a = Number(b.amount), methode = String(b.method || ''), account = String(b.account || '').trim();
    const taux_ = (dep ? FRAIS_DEPOT : FRAIS_RETRAIT)[methode];
    if (!DEVISES_DEPART.includes(b.currency) || !(a > 0) || taux_ === undefined) return json(res, 400, { error: 'Opération invalide.' });
    if (a / c.rates[b.currency] > MAX_EUR) return json(res, 400, { error: 'Montant au-dessus du plafond de ' + MAX_EUR + ' €.' });
    const besoinCompte = MOBILE.includes(methode) || (!dep && methode === 'Virement bancaire');
    if (besoinCompte && (account.length < 8 || account.length > 60)) return json(res, 400, { error: 'Compte invalide.' });
    if (b.key && cles.has(b.key)) return json(res, 200, public_(transferts.get(cles.get(b.key))));
    const frais = Math.round(a * taux_ * 100) / 100;
    const t = { id: crypto.randomUUID(), ref: 'PSG-' + crypto.randomBytes(3).toString('hex').toUpperCase(), type: dep ? 'deposit' : 'withdrawal',
      from: b.currency, to: b.currency, amount: a, fee: frais, total: a + frais, received: a, country: '', method: methode,
      name: '', account, status: 'processing', createdAt: Date.now() };
    try {
      const p = providerFor(t);
      const r = await (dep ? p.cashIn(t) : p.cashOut(t));
      t.status = r.status; t.providerRef = r.providerRef; t.reason = r.reason;
    } catch (e) { return json(res, 502, { error: 'Le prestataire est indisponible, réessayez.' }); }
    transferts.set(t.id, t); transferts.set(t.ref, t);
    if (b.key) cles.set(b.key, t.id);
    return json(res, 201, public_(t));
  }

  const m = url.pathname.match(/^\/api\/transfers\/([A-Za-z0-9-]+)$/);
  if (req.method === 'GET' && m) {
    const t = transferts.get(m[1]);
    if (!t) return json(res, 404, { error: 'Envoi introuvable.' });
    try { if (t.status === 'processing') t.status = await providerFor(t).status(t); } catch (e) {}
    return json(res, 200, public_(t));
  }
  return json(res, 404, { error: 'Introuvable.' });
}

const PUBLIC = ['index.html', 'manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png']; // seuls ces fichiers sont servis
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/rates') {
    try {
      const c = await taux();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ base: c.base, updated: c.updated, sources: c.sources, stale: c.stale, rates: c.rates }));
    } catch (e) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Taux indisponibles' }));
    }
  }
  if (url.pathname.startsWith('/api/')) { try { return await api(req, res, url); } catch (e) { return json(res, 500, { error: 'Erreur serveur.' }); } }
  const nom = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!PUBLIC.includes(nom)) { res.writeHead(404); return res.end('Introuvable'); }
  const fichier = path.join(__dirname, nom);
  fs.readFile(fichier, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Introuvable'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(fichier)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log('Passerelle sur http://localhost:' + PORT));
