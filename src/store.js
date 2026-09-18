import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { defaultCategories, legacyIcons } from './categories.js';
import { LOCAL_OWNER_ID, migrateOwnership } from './ownership-migration.js';
import { all as pgAll, one as pgOne, run as pgRun, transaction as pgTransaction } from './postgres.js';

export const isPostgres = Boolean(process.env.DATABASE_URL) && process.env.SQLITE_SOURCE !== 'true';
// PostgreSQL schema changes run explicitly during deployment, never on requests.
export const ready = Promise.resolve();
let db;
let key;
if (!isPostgres) {
  mkdirSync('data', { recursive: true });
  const keyPath = 'data/token.key';
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  key = readFileSync(keyPath);
  db = new DatabaseSync('data/expenses.sqlite');
  db.exec('PRAGMA journal_mode=WAL');
  migrateOwnership(db);
}
export { db };
const requestUser = new AsyncLocalStorage();
const sessionLifetime = 30 * 86400000;
const digest = value => createHash('sha256').update(value).digest('hex');
export function withUser(id, callback) { return requestUser.run(id, callback); }
export function enterUser(id) { requestUser.enterWith(id); }
export function userId() { return requestUser.getStore() || LOCAL_OWNER_ID; }
function seedCategories(id) {
  for (const [name, icon] of defaultCategories) db.prepare('INSERT OR IGNORE INTO categories(user_id,name,icon) VALUES (?, ?, ?)').run(id, name, icon);
}
export function findOrCreateUser(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || normalized.length > 320) throw new Error('Google did not return a valid email address.');
  if (isPostgres) return (async () => {
    await ready;
    let user = await pgOne('SELECT id FROM users WHERE email=?', [normalized]);
    if (!user) {
      const id = randomBytes(16).toString('hex');
      await pgRun('INSERT INTO users(id,email) VALUES (?,?)', [id, normalized]);
      for (const [name, icon] of defaultCategories) await pgRun('INSERT INTO categories(user_id,name,icon) VALUES (?,?,?) ON CONFLICT DO NOTHING', [id, name, icon]);
      user = { id };
    }
    return user.id;
  })();
  let user = db.prepare('SELECT id FROM users WHERE email=?').get(normalized);
  if (!user) {
    const id = randomBytes(16).toString('hex');
    db.prepare('INSERT INTO users(id,email) VALUES (?,?)').run(id, normalized);
    seedCategories(id);
    user = { id };
  }
  return user.id;
}
export function createSession(id) {
  if (isPostgres) return (async () => { await ready; const token = randomBytes(32).toString('base64url'); await pgRun('INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (?,?,?)', [digest(token), id, Date.now() + sessionLifetime]); return token; })();
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (?,?,?)').run(digest(token), id, Date.now() + sessionLifetime);
  return token;
}
export function sessionUser(token) {
  if (!token) return null;
  if (isPostgres) return (async () => { await ready; const hash = digest(token); const row = await pgOne('SELECT user_id,expires_at FROM sessions WHERE id_hash=?', [hash]); if (!row) return null; if (Number(row.expires_at) <= Date.now()) { await pgRun('DELETE FROM sessions WHERE id_hash=?', [hash]); return null; } return row.user_id; })();
  const hash = digest(token);
  const row = db.prepare('SELECT user_id,expires_at FROM sessions WHERE id_hash=?').get(hash);
  if (!row) return null;
  if (row.expires_at <= Date.now()) { db.prepare('DELETE FROM sessions WHERE id_hash=?').run(hash); return null; }
  return row.user_id;
}
export function deleteSession(token) { if (!token) return; if (isPostgres) return (async () => { await ready; await pgRun('DELETE FROM sessions WHERE id_hash=?', [digest(token)]); })(); db.prepare('DELETE FROM sessions WHERE id_hash=?').run(digest(token)); }
if (!isPostgres) {
  seedCategories(userId());
  db.prepare("INSERT OR IGNORE INTO categories(user_id,name,icon) SELECT ?, category, 'folder' FROM transactions WHERE category <> ''").run(userId());
  for (const [emoji, icon] of Object.entries(legacyIcons)) {
    db.prepare('UPDATE categories SET icon=? WHERE user_id=? AND icon=?').run(icon, userId(), emoji);
  }
}
export function get(key) { if (isPostgres) return (async () => { await ready; return (await pgOne('SELECT value FROM settings WHERE user_id=? AND key=?', [userId(), key]))?.value; })(); return db.prepare('SELECT value FROM settings WHERE user_id=? AND key=?').get(userId(), key)?.value; }
export function set(key, value) { if (isPostgres) return (async () => { await ready; await pgRun('INSERT INTO settings(user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=EXCLUDED.value', [userId(), key, value]); })(); return db.prepare('INSERT OR REPLACE INTO settings(user_id,key,value) VALUES (?, ?, ?)').run(userId(), key, value); }
function normalizeRow(row) {
  if (!row) return row;
  for (const field of ['amount', 'review', 'expires_at']) if (typeof row[field] === 'string' && /^-?\d+$/.test(row[field])) row[field] = Number(row[field]);
  return row;
}
export async function all(sql, params = []) { await ready; return isPostgres ? (await pgAll(sql, params)).map(normalizeRow) : db.prepare(sql).all(...params); }
export async function one(sql, params = []) { await ready; return isPostgres ? normalizeRow(await pgOne(sql, params)) : db.prepare(sql).get(...params); }
export async function run(sql, params = []) { await ready; return isPostgres ? pgRun(sql, params) : db.prepare(sql).run(...params); }
export async function transaction(callback) { await ready; return isPostgres ? pgTransaction(callback) : callback({ all: async (sql, params) => db.prepare(sql).all(...params), one: async (sql, params) => db.prepare(sql).get(...params), run: async (sql, params) => db.prepare(sql).run(...params) }); }
export function saveTokens(tokens) {
  if (isPostgres) return (async () => { const secret = process.env.TOKEN_ENCRYPTION_KEY; if (!secret) throw new Error('TOKEN_ENCRYPTION_KEY is required for PostgreSQL.'); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', Buffer.from(secret, 'base64'), iv); const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens)), cipher.final()]); await set('tokens', Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')); })();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens)), cipher.final()]);
  set('tokens', Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64'));
}
export function readTokens() {
  if (isPostgres) return (async () => { const encoded = await get('tokens'); if (!encoded) return null; const secret = process.env.TOKEN_ENCRYPTION_KEY; if (!secret) throw new Error('TOKEN_ENCRYPTION_KEY is required for PostgreSQL.'); const data = Buffer.from(encoded, 'base64'); const decipher = createDecipheriv('aes-256-gcm', Buffer.from(secret, 'base64'), data.subarray(0, 12)); decipher.setAuthTag(data.subarray(12, 28)); return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString()); })();
  if (!get('tokens')) return null;
  const data = Buffer.from(get('tokens'), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
}
