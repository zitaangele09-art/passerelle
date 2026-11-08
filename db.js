// Base de données SQLite (intégrée à Node 22.5+, aucune dépendance).
// Le chemin du fichier se règle avec DB_PATH. Sur Render, le disque du plan gratuit est
// effacé à chaque redémarrage : pour garder les données, il faut un disque persistant (plan payant)
// ou une base PostgreSQL (voir README).
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.DB_PATH || './passerelle.db');
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, phone TEXT UNIQUE NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
  pin_salt TEXT NOT NULL, pin_hash TEXT NOT NULL, pin_fails INTEGER NOT NULL DEFAULT 0,
  pin_locked_until INTEGER NOT NULL DEFAULT 0, kyc TEXT NOT NULL DEFAULT 'none', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS otps (
  phone TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ops (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL, status TEXT NOT NULL, currency TEXT NOT NULL, to_currency TEXT,
  amount INTEGER NOT NULL, fee INTEGER NOT NULL, received INTEGER, eur REAL NOT NULL DEFAULT 0,
  country TEXT, method TEXT, name TEXT, account TEXT, provider_ref TEXT, reason TEXT, idem TEXT,
  created_at INTEGER NOT NULL, UNIQUE (user_id, idem));
-- Registre des soldes : on n'écrit jamais de solde, seulement des mouvements. Le solde = la somme des mouvements.
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), currency TEXT NOT NULL,
  amount INTEGER NOT NULL, kind TEXT NOT NULL, op_ref TEXT, created_at INTEGER NOT NULL,
  UNIQUE (op_ref, kind));
CREATE INDEX IF NOT EXISTS ledger_user ON ledger (user_id, currency);
CREATE INDEX IF NOT EXISTS ops_user ON ops (user_id, id);
`);

// Montants stockés en entiers (plus petite unité) : jamais de virgule flottante pour l'argent.
const ZERO = new Set(['XOF', 'XAF', 'JPY', 'KRW', 'UGX', 'RWF', 'GNF', 'KMF', 'DJF', 'BIF', 'VND', 'CLP', 'PYG']);
const facteur = c => (ZERO.has(c) ? 1 : 100);
const toMinor = (c, x) => Math.round(Number(x) * facteur(c));
const toMajor = (c, m) => m / facteur(c);

function tx(fn) {            // transaction : tout ou rien, un seul écrivain à la fois
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}
const balance = (uid, cur) =>
  db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM ledger WHERE user_id=? AND currency=?').get(uid, cur).s;
const balances = uid => {
  const o = {};
  for (const r of db.prepare('SELECT currency, SUM(amount) AS s FROM ledger WHERE user_id=? GROUP BY currency').all(uid)) o[r.currency] = r.s;
  return o;
};
module.exports = { db, tx, toMinor, toMajor, balance, balances };
