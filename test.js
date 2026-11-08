// Tests automatiques : node test.js   (lance le serveur lui-même, base temporaire, taux simulés)
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'psg-')), DB = path.join(tmp, 't.db'), PORT = 3555;
fs.writeFileSync(path.join(tmp, 'mock.js'), `global.fetch=async u=>{u=String(u);
 if(u.includes('ecb'))return{ok:true,text:async()=>"<Cube currency='USD' rate='1.1200'/>"};
 if(u.includes('er-api'))return{ok:true,json:async()=>({rates:{EUR:1,USD:1.1,XOF:655.957,MAD:10.95,NGN:1620}})};
 throw new Error('hors ligne')}`);
let child;
const start = () => new Promise(r => { child = spawn('node', ['-r', path.join(tmp, 'mock.js'), path.join(__dirname, 'server.js')],
  { env: { ...process.env, PORT, DB_PATH: DB }, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', d => { if (/sur http/.test(d)) r(); }); child.stderr.on('data', () => {}); });
const stop = () => new Promise(r => { child.on('exit', r); child.kill(); });
const call = async (m, p, b, tok) => { const r = await fetch('http://localhost:' + PORT + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); const j = await r.json().catch(() => ({})); j._s = r.status; return j; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ok = 0; const t = async (nom, fn) => { try { await fn(); ok++; console.log('  ✓', nom); } catch (e) { console.log('  ✗', nom, '\n     ', e.message); process.exitCode = 1; } };

async function register(phone, fn, ln, pin) {
  const o = await call('POST', '/api/auth/request-otp', { phone }); assert(o.devCode, 'pas de code de test');
  const v = await call('POST', '/api/auth/verify', { phone, code: o.devCode, firstName: fn, lastName: ln, pin }); assert(v.token, JSON.stringify(v)); return v.token;
}
(async () => {
  await start();
  console.log('Comptes et connexion');
  let A, B;
  await t('numéro invalide refusé', async () => assert.equal((await call('POST', '/api/auth/request-otp', { phone: '12' }))._s, 400));
  await t('mauvais code refusé puis 5 essais max', async () => {
    const o = await call('POST', '/api/auth/request-otp', { phone: '+221771110000' });
    for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/verify', { phone: '+221771110000', code: '000000', firstName: 'Aa', lastName: 'Bb', pin: '1234' }))._s, 400);
    assert.equal((await call('POST', '/api/auth/verify', { phone: '+221771110000', code: o.devCode, firstName: 'Aa', lastName: 'Bb', pin: '1234' }))._s, 429);
  });
  await t('inscription (prénom, nom, PIN) + connexion', async () => { A = await register('+221 77 123 45 67', 'Awa', 'Diop', '1234'); B = await register('+229 97 12 34 56', 'Koffi', 'Adjovi', '4321'); });
  await t('inscription sans nom ou avec PIN invalide refusée', async () => {
    const p = '+221770000001', o = await call('POST', '/api/auth/request-otp', { phone: p });
    assert.equal((await call('POST', '/api/auth/verify', { phone: p, code: o.devCode, firstName: 'A', lastName: '', pin: '1234' }))._s, 400);
    assert.equal((await call('POST', '/api/auth/verify', { phone: p, code: o.devCode, firstName: 'Awa', lastName: 'Diop', pin: '12' }))._s, 400);
  });
  await t('sans connexion : accès refusé', async () => { assert.equal((await call('GET', '/api/me'))._s, 401); assert.equal((await call('POST', '/api/transfers', {}))._s, 401); });
  await t('profil et soldes à zéro', async () => { const m = await call('GET', '/api/me', null, A); assert.equal(m.user.firstName, 'Awa'); assert.equal(m.balances.XOF, 0); });
  await t('connexion existant : même compte', async () => {
    const o = await call('POST', '/api/auth/request-otp', { phone: '+221771234567' }); assert.equal(o.exists, true);
    const v = await call('POST', '/api/auth/verify', { phone: '+221771234567', code: o.devCode }); assert(v.token && !v.isNew);
  });
  console.log('PIN');
  await t('PIN correct accepté', async () => assert.equal((await call('POST', '/api/pin/check', { pin: '1234' }, A))._s, 200));
  await t('5 mauvais PIN verrouillent le compte', async () => {
    for (let i = 0; i < 5; i++) await call('POST', '/api/pin/check', { pin: '9999' }, B);
    const r = await call('POST', '/api/pin/check', { pin: '4321' }, B); assert.equal(r._s, 403); assert(r.locked);
  });
  console.log('Dépôts et registre des soldes');
  await t('dépôt Wave : en cours puis crédité', async () => {
    const d = await call('POST', '/api/deposits', { currency: 'XOF', amount: 1000000, method: 'Wave', account: '771234567', key: 'dep1' }, A);
    assert.equal(d.status, 'processing'); assert.equal((await call('GET', '/api/me', null, A)).balances.XOF, 0, 'crédité trop tôt');
    await sleep(8500); assert.equal((await call('GET', '/api/me', null, A)).balances.XOF, 1000000);
  });
  await t('même clé = pas de double dépôt', async () => {
    const d = await call('POST', '/api/deposits', { currency: 'XOF', amount: 1000000, method: 'Wave', account: '771234567', key: 'dep1' }, A);
    assert.equal(d._s, 200); await sleep(500); assert.equal((await call('GET', '/api/me', null, A)).balances.XOF, 1000000);
  });
  await t('dépôt refusé par le prestataire : pas crédité', async () => {
    const d = await call('POST', '/api/deposits', { currency: 'XOF', amount: 5000, method: 'Wave', account: '771230000', key: 'dep2' }, A);
    assert.equal(d.status, 'failed'); assert.equal((await call('GET', '/api/me', null, A)).balances.XOF, 1000000);
  });
  console.log('Envois');
  await t('envoi sans PIN refusé', async () => assert.equal((await call('POST', '/api/transfers', { from: 'XOF', to: 'XOF', amount: 1000, country: 'Sénégal', method: 'Wave', name: 'Fatou Ndiaye', account: '771111111', key: 's0' }, A))._s, 403));
  await t('envoi : débit = montant + frais', async () => {
    const r = await call('POST', '/api/transfers', { from: 'XOF', to: 'XOF', amount: 100000, country: 'Sénégal', method: 'Wave', name: 'Fatou Ndiaye', account: '771111111', pin: '1234', key: 's1' }, A);
    assert.equal(r._s, 201, JSON.stringify(r)); assert.equal(r.fee, Math.round(100000 * 0.009 + 655.957)); assert.equal(r.received, 100000);
    assert.equal((await call('GET', '/api/me', null, A)).balances.XOF, 1000000 - 100000 - r.fee);
  });
  await t('même clé = pas de double débit', async () => {
    const avant = (await call('GET', '/api/me', null, A)).balances.XOF;
    const r = await call('POST', '/api/transfers', { from: 'XOF', to: 'XOF', amount: 100000, country: 'Sénégal', method: 'Wave', name: 'Fatou Ndiaye', account: '771111111', pin: '1234', key: 's1' }, A);
    assert.equal(r._s, 200); assert.equal((await call('GET', '/api/me', null, A)).balances.XOF, avant);
  });
  await t('solde insuffisant refusé', async () => { const r = await call('POST', '/api/transfers', { from: 'EUR', to: 'XOF', amount: 50, country: 'Sénégal', method: 'Wave', name: 'Fatou Ndiaye', account: '771111111', pin: '1234', key: 's2' }, A); assert.equal(r._s, 400); assert(/insuffisant/i.test(r.error)); });
  await t('envoi refusé par le prestataire : remboursé', async () => {
    const avant = (await call('GET', '/api/me', null, A)).balances.XOF;
    const r = await call('POST', '/api/transfers', { from: 'XOF', to: 'XOF', amount: 50000, country: 'Sénégal', method: 'Wave', name: 'Fatou Ndiaye', account: '771230000', pin: '1234', key: 's3' }, A);
    assert.equal(r.status, 'failed'); assert.equal((await call('GET', '/api/me', null, A)).balances.XOF, avant);
  });
  await t('envoi vers le Nigeria au taux du serveur', async () => {
    const r = await call('POST', '/api/transfers', { from: 'XOF', to: 'NGN', amount: 100000, country: 'Nigeria', method: 'Virement bancaire', name: 'Chidi Okafor', account: 'NG12345678', pin: '1234', key: 's4' }, A);
    assert.equal(r._s, 201); assert(Math.abs(r.received - 100000 / 655.957 * 1620) < 1, 'reçu=' + r.received);
  });
  await t('plafond du jour appliqué', async () => {
    await call('POST', '/api/deposits', { currency: 'EUR', amount: 4000, method: 'Virement bancaire', key: 'dep3' }, A);
    const r = await call('POST', '/api/transfers', { from: 'EUR', to: 'XOF', amount: 2000, country: 'Sénégal', method: 'Wave', name: 'Fatou Ndiaye', account: '771111111', pin: '1234', key: 's5' }, A);
    assert.equal(r._s, 400);
  });
  await t('retrait Wave : débité puis envoyé', async () => {
    const avant = (await call('GET', '/api/me', null, A)).balances.XOF;
    const r = await call('POST', '/api/withdrawals', { currency: 'XOF', amount: 20000, method: 'Wave', account: '771234567', pin: '1234', key: 'w1' }, A);
    assert.equal(r._s, 201); assert.equal(r.fee, 200); assert.equal((await call('GET', '/api/me', null, A)).balances.XOF, avant - 20200);
  });
  console.log('Sécurité et robustesse');
  await t('30 envois simultanés : le solde ne passe jamais sous zéro', async () => {
    const C = await register('+221 78 000 00 01', 'Test', 'Course', '1111');
    await call('POST', '/api/deposits', { currency: 'XOF', amount: 300000, method: 'Virement bancaire', key: 'd' }, C); await sleep(7500);
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => call('POST', '/api/transfers', { from: 'XOF', to: 'XOF', amount: 100000, country: 'Sénégal', method: 'Wave', name: 'Test Test', account: '771111111', pin: '1111', key: 'c' + i }, C)));
    const reussis = rs.filter(r => r._s === 201 && r.status !== 'failed').length, bal = (await call('GET', '/api/me', null, C)).balances.XOF;
    assert(bal >= 0, 'solde négatif : ' + bal); assert(reussis <= 2, reussis + ' envois acceptés pour 300 000 FCFA'); assert(rs.some(r => /insuffisant|Trop/i.test(r.error || '')));
  });
  await t('un utilisateur ne voit pas les envois d’un autre', async () => {
    const h = await call('GET', '/api/history', null, A); assert(h.ops.length > 0);
    assert.equal((await call('GET', '/api/transfers/' + h.ops[0].ref, null, B))._s, 404);
    assert.equal((await call('GET', '/api/history', null, B)).ops.length, 0);
  });
  await t('jeton falsifié refusé', async () => assert.equal((await call('GET', '/api/me', null, 'a'.repeat(64)))._s, 401));
  await t('déconnexion invalide le jeton', async () => { await call('POST', '/api/auth/logout', {}, B); assert.equal((await call('GET', '/api/me', null, B))._s, 401); });
  await t('les fichiers du serveur ne sont pas téléchargeables', async () => { for (const f of ['server.js', 'db.js', 'passerelle.db', 'package.json']) assert.equal((await fetch('http://localhost:' + PORT + '/' + f)).status, 404, f); });
  console.log('Persistance');
  const avant = (await call('GET', '/api/me', null, A)).balances;
  await stop(); await start();
  await t('après redémarrage : comptes, jeton et soldes conservés', async () => { const m = await call('GET', '/api/me', null, A); assert.equal(m._s, 200); assert.deepEqual(m.balances, avant); });
  await stop();
  console.log('\n' + ok + ' tests réussis' + (process.exitCode ? ', des échecs sont signalés ci-dessus' : ' — aucun échec'));
  process.exit(process.exitCode || 0);
})();
