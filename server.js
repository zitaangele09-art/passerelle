// Passerelle v2 : comptes (téléphone + code SMS + PIN), registre des soldes, base de données, taux en direct.
// Mode TEST : aucun argent réel ne bouge tant qu'aucun prestataire agréé n'est branché (providers.js).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { providerFor } = require('./providers');
const sms = require('./sms');
const D = require('./db');
const db = D.db;

const PORT = process.env.PORT || 3000;
const TTL = 10 * 60 * 1000;
const FIXES = { EUR: 1, XOF: 655.957, XAF: 655.957, KMF: 491.96775, CVE: 110.265, STN: 24.5, BAM: 1.95583 };
const DEPART = ['XOF', 'EUR', 'USD'];                 // devises des comptes
const MAX_EUR = 5000, DAY_EUR = 1500, MON_EUR = 5000;  // plafonds de démonstration
const MOBILE = ['Wave', 'Orange Money', 'MTN MoMo', 'Moov Money'];
const FRAIS_DEPOT = { 'Carte bancaire': 0.015, 'Virement bancaire': 0, 'Wave': 0.005, 'Orange Money': 0.005, 'MTN MoMo': 0.005, 'Moov Money': 0.005, 'Dépôt en agence': 0 };
const FRAIS_RETRAIT = { 'Wave': 0.01, 'Orange Money': 0.01, 'MTN MoMo': 0.01, 'Moov Money': 0.01, 'Virement bancaire': 0.005, 'Retrait en agence': 0.015 };
const PEPPER = process.env.PIN_PEPPER || '';

// ---------- Taux de change ----------
let cache = null;
async function lireBCE() {
  const r = await fetch('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
  if (!r.ok) throw new Error('BCE ' + r.status);
  const xml = await r.text(), rates = {};
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) rates[m[1]] = parseFloat(m[2]);
  return rates;
}
async function lireMarche() {
  const r = await fetch('https://open.er-api.com/v6/latest/EUR');
  if (!r.ok) throw new Error('er-api ' + r.status);
  const j = await r.json(); if (!j.rates) throw new Error('vide'); return j.rates;
}
async function taux() {
  if (cache && Date.now() - cache.at < TTL) return cache;
  const [bce, marche] = await Promise.allSettled([lireBCE(), lireMarche()]);
  if (bce.status === 'rejected' && marche.status === 'rejected') {
    if (cache) { cache.stale = true; return cache; }
    throw new Error('aucune source de taux');
  }
  cache = { rates: Object.assign({}, marche.value || {}, bce.value || {}, FIXES), updated: new Date().toISOString(), at: Date.now(), stale: false };
  return cache;
}

// ---------- Outils ----------
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const eqt = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const pinHash = (pin, salt) => crypto.scryptSync(PEPPER + pin, salt, 32).toString('hex');
const now = () => Date.now();
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(obj)); }
function corps(req) {
  return new Promise((ok, ko) => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 20000) { ko(new Error('trop gros')); req.destroy(); } });
    req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { ko(e); } });
  });
}
const compteurs = new Map();
function limite(cle, max) {
  const t = now(), m = compteurs.get(cle) || { n: 0, t };
  if (t - m.t > 60000) { m.n = 0; m.t = t; }
  m.n++; compteurs.set(cle, m); return m.n > max;
}
setInterval(() => { const t = now(); for (const [k, v] of compteurs) if (t - v.t > 120000) compteurs.delete(k); }, 60000).unref();
const phoneOK = p => { let s = String(p || '').replace(/[\s.\-()]/g, ''); if (s.startsWith('00')) s = '+' + s.slice(2); return /^\+\d{8,15}$/.test(s) ? s : null; };
const pinValide = p => /^\d{4}$/.test(String(p || ''));

function userFromReq(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer ([a-f0-9]{64})$/);
  if (!m) return null;
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?').get(sha(m[1]), now()) || null;
}
function checkPin(u, pin) {
  if (u.pin_locked_until > now()) return { ok: false, locked: true, error: 'Trop d’essais. Réessayez dans quelques minutes.' };
  if (pinValide(pin) && eqt(pinHash(String(pin), u.pin_salt), u.pin_hash)) {
    if (u.pin_fails) db.prepare('UPDATE users SET pin_fails=0 WHERE id=?').run(u.id);
    return { ok: true };
  }
  const f = u.pin_fails + 1;
  if (f >= 5) { db.prepare('UPDATE users SET pin_fails=0, pin_locked_until=? WHERE id=?').run(now() + 15 * 60000, u.id); return { ok: false, locked: true, error: 'Trop d’essais. Compte verrouillé 15 minutes.' }; }
  db.prepare('UPDATE users SET pin_fails=? WHERE id=?').run(f, u.id);
  return { ok: false, error: 'Code PIN incorrect (' + (5 - f) + ' essai(s) restant(s)).' };
}

// ---------- Opérations et registre ----------
const majorOf = (cur, v) => (v == null ? null : D.toMajor(cur, v));
function pub(o) {
  return { ref: o.ref, type: o.type, status: o.status, reason: o.reason || null, currency: o.currency, toCurrency: o.to_currency || o.currency,
    amount: majorOf(o.currency, o.amount), fee: majorOf(o.currency, o.fee), total: majorOf(o.currency, o.amount + o.fee),
    received: majorOf(o.to_currency || o.currency, o.received), country: o.country, method: o.method, name: o.name, account: o.account, createdAt: o.created_at };
}
const asT = o => ({ id: o.ref, ref: o.ref, type: o.type, from: o.currency, to: o.to_currency || o.currency, amount: majorOf(o.currency, o.amount),
  fee: majorOf(o.currency, o.fee), received: majorOf(o.to_currency || o.currency, o.received), country: o.country, method: o.method,
  name: o.name, account: o.account, createdAt: o.created_at, status: o.status, providerRef: o.provider_ref });

function poster(uid, cur, montant, kind, ref) {   // écrit un mouvement ; une même (opération, nature) ne s'écrit qu'une fois
  db.prepare('INSERT OR IGNORE INTO ledger (user_id,currency,amount,kind,op_ref,created_at) VALUES (?,?,?,?,?,?)').run(uid, cur, montant, kind, ref, now());
}
function changerStatut(ref, status, reason, providerRef) {
  D.tx(() => {
    const o = db.prepare('SELECT * FROM ops WHERE ref=?').get(ref);
    if (!o || o.status !== 'processing') return;
    db.prepare('UPDATE ops SET status=?, reason=?, provider_ref=COALESCE(?,provider_ref) WHERE ref=?').run(status, reason || null, providerRef || null, ref);
    if (o.type === 'deposit' && status === 'paid') poster(o.user_id, o.currency, o.amount, 'deposit_credit', ref);
    if (o.type !== 'deposit' && status === 'failed') poster(o.user_id, o.currency, o.amount + o.fee, o.type === 'transfer' ? 'send_refund' : 'withdraw_refund', ref);
  });
}
function usageEur(uid) {
  const d = new Date(), j0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), m0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const q = t => db.prepare("SELECT COALESCE(SUM(eur),0) AS s FROM ops WHERE user_id=? AND type='transfer' AND status<>'failed' AND created_at>=?").get(uid, t).s;
  return { day: q(j0), mon: q(m0) };
}

async function demarrer(res, u, spec, b) {
  // 1) idempotence : même clé = même opération, jamais de doublon
  if (b.key) {
    const ex = db.prepare('SELECT * FROM ops WHERE user_id=? AND idem=?').get(u.id, String(b.key).slice(0, 80));
    if (ex) return json(res, 200, pub(ex));
  }
  const ref = 'PSG-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  // 2) débit + création de l'opération dans UNE transaction (le solde ne peut pas passer sous zéro)
  const r = D.tx(() => {
    if (spec.debit && D.balance(u.id, spec.cur) < spec.amount + spec.fee) return { err: 'Solde insuffisant.' };
    db.prepare(`INSERT INTO ops (ref,user_id,type,status,currency,to_currency,amount,fee,received,eur,country,method,name,account,idem,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ref, u.id, spec.type, 'processing', spec.cur, spec.to || spec.cur, spec.amount, spec.fee, spec.received,
      spec.eur || 0, spec.country || '', spec.method, spec.name || '', spec.account || '', b.key ? String(b.key).slice(0, 80) : null, now());
    if (spec.debit) poster(u.id, spec.cur, -(spec.amount + spec.fee), spec.type === 'transfer' ? 'send_debit' : 'withdraw_debit', ref);
    return { ok: true };
  });
  if (r.err) return json(res, 400, { error: r.err });
  // 3) appel au prestataire (hors transaction)
  const o = db.prepare('SELECT * FROM ops WHERE ref=?').get(ref), t = asT(o);
  try {
    const p = providerFor(t);
    const out = await (spec.type === 'transfer' ? p.send(t) : spec.type === 'deposit' ? p.cashIn(t) : p.cashOut(t));
    if (out.status === 'failed' || out.status === 'paid') changerStatut(ref, out.status, out.reason, out.providerRef);
    else if (out.providerRef) db.prepare('UPDATE ops SET provider_ref=? WHERE ref=?').run(out.providerRef, ref);
  } catch (e) {
    changerStatut(ref, 'failed', 'Prestataire indisponible');
    return json(res, 502, { error: 'Le prestataire est indisponible, vous n’avez pas été débité.' });
  }
  return json(res, 201, pub(db.prepare('SELECT * FROM ops WHERE ref=?').get(ref)));
}

// Relève les opérations en cours auprès du prestataire (même si l'application est fermée)
async function balayer() {
  for (const o of db.prepare("SELECT * FROM ops WHERE status='processing'").all()) {
    const t = asT(o);
    try { const st = await providerFor(t).status(t); if (st === 'paid' || st === 'failed') changerStatut(o.ref, st, null); } catch (_) {}
  }
}

// ---------- Routes ----------
async function api(req, res, url) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x').split(',')[0].trim();
  const p = url.pathname, M = req.method;
  if (limite('g' + ip, 240)) return json(res, 429, { error: 'Trop de requêtes, réessayez dans une minute.' });
  if (M === 'GET' && p === '/api/health') return json(res, 200, { ok: true, accounts: true, sms: process.env.SMS_PROVIDER ? 'live' : 'test' });

  if (M === 'GET' && p === '/api/rates') {
    try { const c = await taux(); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' });
      return res.end(JSON.stringify({ base: 'EUR', updated: c.updated, stale: c.stale, rates: c.rates })); }
    catch (e) { return json(res, 503, { error: 'Taux indisponibles' }); }
  }

  // --- Connexion par SMS ---
  if (M === 'POST' && p === '/api/auth/request-otp') {
    if (limite('o' + ip, 10)) return json(res, 429, { error: 'Trop de demandes, réessayez plus tard.' });
    let b; try { b = await corps(req); } catch (e) { return json(res, 400, { error: 'Requête illisible.' }); }
    const phone = phoneOK(b.phone); if (!phone) return json(res, 400, { error: 'Numéro invalide. Entrez-le avec l’indicatif, ex. +221 77 123 45 67.' });
    const old = db.prepare('SELECT sent_at FROM otps WHERE phone=?').get(phone);
    if (old && now() - old.sent_at < 30000) return json(res, 429, { error: 'Attendez 30 secondes avant de demander un nouveau code.' });
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.prepare('INSERT INTO otps (phone,code_hash,expires,attempts,sent_at) VALUES (?,?,?,0,?) ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expires=excluded.expires, attempts=0, sent_at=excluded.sent_at')
      .run(phone, sha(code + phone), now() + 5 * 60000, now());
    let r; try { r = await sms.send(phone, 'Passerelle : votre code est ' + code + '. Il expire dans 5 minutes.'); }
    catch (e) { return json(res, 502, { error: 'Impossible d’envoyer le SMS pour le moment.' }); }
    const out = { ok: true, exists: !!db.prepare('SELECT 1 FROM users WHERE phone=?').get(phone) };
    if (r && r.devCode) out.devCode = code;      // MODE TEST uniquement
    return json(res, 200, out);
  }
  if (M === 'POST' && p === '/api/auth/verify') {
    if (limite('v' + ip, 20)) return json(res, 429, { error: 'Trop d’essais, réessayez plus tard.' });
    let b; try { b = await corps(req); } catch (e) { return json(res, 400, { error: 'Requête illisible.' }); }
    const phone = phoneOK(b.phone), otp = phone && db.prepare('SELECT * FROM otps WHERE phone=?').get(phone);
    if (!otp || otp.expires < now()) return json(res, 400, { error: 'Code expiré. Demandez-en un nouveau.' });
    if (otp.attempts >= 5) return json(res, 429, { error: 'Trop d’essais. Demandez un nouveau code.' });
    if (!eqt(sha(String(b.code || '') + phone), otp.code_hash)) {
      db.prepare('UPDATE otps SET attempts=attempts+1 WHERE phone=?').run(phone);
      return json(res, 400, { error: 'Code incorrect.' });
    }
    let u = db.prepare('SELECT * FROM users WHERE phone=?').get(phone), isNew = false;
    if (!u) {
      const fn = String(b.firstName || '').trim(), ln = String(b.lastName || '').trim();
      if (fn.length < 2 || fn.length > 40 || ln.length < 2 || ln.length > 40) return json(res, 400, { error: 'Prénom et nom requis (2 à 40 caractères).' });
      if (!pinValide(b.pin)) return json(res, 400, { error: 'Le code PIN doit avoir 4 chiffres.' });
      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare('INSERT INTO users (phone,first_name,last_name,pin_salt,pin_hash,created_at) VALUES (?,?,?,?,?,?)').run(phone, fn, ln, salt, pinHash(String(b.pin), salt), now());
      u = db.prepare('SELECT * FROM users WHERE phone=?').get(phone); isNew = true;
    } else if (b.resetPin) {                       // le SMS prouve la possession du numéro : on peut changer le PIN
      if (!pinValide(b.pin)) return json(res, 400, { error: 'Le code PIN doit avoir 4 chiffres.' });
      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare('UPDATE users SET pin_salt=?, pin_hash=?, pin_fails=0, pin_locked_until=0 WHERE id=?').run(salt, pinHash(String(b.pin), salt), u.id);
    }
    db.prepare('DELETE FROM otps WHERE phone=?').run(phone);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token_hash,user_id,expires) VALUES (?,?,?)').run(sha(token), u.id, now() + 30 * 86400000);
    return json(res, 200, { token, isNew, user: { firstName: u.first_name, lastName: u.last_name, phone: u.phone } });
  }

  // --- Tout ce qui suit demande d'être connecté ---
  const u = userFromReq(req);
  if (!u) return json(res, 401, { error: 'Connexion requise.' });
  if (M === 'POST' && p === '/api/auth/logout') {
    const m = String(req.headers.authorization).match(/Bearer ([a-f0-9]{64})/); db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(m[1])); return json(res, 200, { ok: true });
  }
  if (M === 'GET' && p === '/api/me') {
    const bal = D.balances(u.id), out = {}; for (const c of DEPART) out[c] = D.toMajor(c, bal[c] || 0);
    const us = usageEur(u.id);
    return json(res, 200, { user: { firstName: u.first_name, lastName: u.last_name, phone: u.phone, kyc: u.kyc }, balances: out, limits: { dayEur: us.day, monEur: us.mon, dayMax: DAY_EUR, monMax: MON_EUR } });
  }
  if (M === 'POST' && p === '/api/pin/check') {
    let b; try { b = await corps(req); } catch (e) { return json(res, 400, { error: 'Requête illisible.' }); }
    const r = checkPin(u, b.pin); return json(res, r.ok ? 200 : 403, r);
  }
  if (M === 'GET' && p === '/api/history') {
    const n = Math.min(100, parseInt(url.searchParams.get('limit')) || 50);
    return json(res, 200, { ops: db.prepare('SELECT * FROM ops WHERE user_id=? ORDER BY id DESC LIMIT ?').all(u.id, n).map(pub) });
  }
  const g = p.match(/^\/api\/transfers\/([A-Za-z0-9-]+)$/);
  if (M === 'GET' && g) {
    const o = db.prepare('SELECT * FROM ops WHERE ref=? AND user_id=?').get(g[1], u.id);
    return o ? json(res, 200, pub(o)) : json(res, 404, { error: 'Introuvable.' });
  }

  if (M === 'POST' && (p === '/api/transfers' || p === '/api/deposits' || p === '/api/withdrawals')) {
    if (limite('t' + u.id, 30)) return json(res, 429, { error: 'Trop d’opérations, réessayez dans une minute.' });
    let b; try { b = await corps(req); } catch (e) { return json(res, 400, { error: 'Requête illisible.' }); }
    let rates; try { rates = (await taux()).rates; } catch (e) { return json(res, 503, { error: 'Taux indisponibles, réessayez.' }); }
    const type = p === '/api/transfers' ? 'transfer' : p === '/api/deposits' ? 'deposit' : 'withdrawal';
    const cur = type === 'transfer' ? b.from : b.currency, a = Number(b.amount), methode = String(b.method || '');
    if (!DEPART.includes(cur) || !(a > 0) || !isFinite(a)) return json(res, 400, { error: 'Montant ou devise invalide.' });
    const amount = D.toMinor(cur, a); if (amount < 1) return json(res, 400, { error: 'Montant trop petit.' });
    const eur = a / rates[cur];
    if (eur > MAX_EUR) return json(res, 400, { error: 'Montant au-dessus du plafond de ' + MAX_EUR + ' €.' });
    const compte = String(b.account || '').trim();
    if (type !== 'deposit') {                      // sortir de l'argent exige le PIN
      const r = checkPin(u, b.pin); if (!r.ok) return json(res, 403, { error: r.error, locked: !!r.locked });
    }
    if (type === 'transfer') {
      if (!rates[b.to]) return json(res, 400, { error: 'Taux indisponible pour cette destination.' });
      const name = String(b.name || '').trim();
      if (name.length < 2 || name.length > 80 || compte.length < 6 || compte.length > 60) return json(res, 400, { error: 'Bénéficiaire invalide.' });
      const us = usageEur(u.id);
      if (us.day + eur > DAY_EUR) return json(res, 400, { error: 'Plafond du jour dépassé.' });
      if (us.mon + eur > MON_EUR) return json(res, 400, { error: 'Plafond du mois dépassé.' });
      const fee = D.toMinor(cur, a * 0.009 + rates[cur]);    // 0,9 % + équivalent de 1 €
      return demarrer(res, u, { type, cur, to: b.to, amount, fee, received: D.toMinor(b.to, a * rates[b.to] / rates[cur]), eur, country: String(b.country || ''),
        method: methode, name, account: compte, debit: true }, b);
    }
    const taux_ = (type === 'deposit' ? FRAIS_DEPOT : FRAIS_RETRAIT)[methode];
    if (taux_ === undefined) return json(res, 400, { error: 'Moyen de paiement invalide.' });
    const besoin = MOBILE.includes(methode) || (type === 'withdrawal' && methode === 'Virement bancaire');
    if (besoin && (compte.length < 8 || compte.length > 60)) return json(res, 400, { error: 'Compte invalide.' });
    return demarrer(res, u, { type, cur, amount, fee: D.toMinor(cur, a * taux_), received: amount, eur, method: methode, account: compte, debit: type === 'withdrawal' }, b);
  }
  return json(res, 404, { error: 'Introuvable.' });
}

const PUBLIC = ['index.html', 'manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const serveur = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) { try { return await api(req, res, url); } catch (e) { console.error(e); return json(res, 500, { error: 'Erreur serveur.' }); } }
  const nom = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!PUBLIC.includes(nom)) { res.writeHead(404); return res.end('Introuvable'); }
  fs.readFile(path.join(__dirname, nom), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Introuvable'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(nom)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(data);
  });
});
if (require.main === module) {
  serveur.listen(PORT, () => console.log('Passerelle (comptes) sur http://localhost:' + PORT));
  setInterval(balayer, 3000);
}
module.exports = { serveur, balayer };
