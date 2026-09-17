import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { defaultCategories, legacyIcons } from './categories.js';
import { LOCAL_OWNER_ID, migrateOwnership } from './ownership-migration.js';

mkdirSync('data', { recursive: true });
const keyPath = 'data/token.key';
if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
const key = readFileSync(keyPath);
export const db = new DatabaseSync('data/expenses.sqlite');
db.exec('PRAGMA journal_mode=WAL');
migrateOwnership(db);
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
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (?,?,?)').run(digest(token), id, Date.now() + sessionLifetime);
  return token;
}
export function sessionUser(token) {
  if (!token) return null;
  const hash = digest(token);
  const row = db.prepare('SELECT user_id,expires_at FROM sessions WHERE id_hash=?').get(hash);
  if (!row) return null;
  if (row.expires_at <= Date.now()) { db.prepare('DELETE FROM sessions WHERE id_hash=?').run(hash); return null; }
  return row.user_id;
}
export function deleteSession(token) { if (token) db.prepare('DELETE FROM sessions WHERE id_hash=?').run(digest(token)); }
seedCategories(userId());
db.prepare("INSERT OR IGNORE INTO categories(user_id,name,icon) SELECT ?, category, 'folder' FROM transactions WHERE category <> ''").run(userId());
for (const [emoji, icon] of Object.entries(legacyIcons)) {
  db.prepare('UPDATE categories SET icon=? WHERE user_id=? AND icon=?').run(icon, userId(), emoji);
}
export function get(key) { return db.prepare('SELECT value FROM settings WHERE user_id=? AND key=?').get(userId(), key)?.value; }
export function set(key, value) { db.prepare('INSERT OR REPLACE INTO settings(user_id,key,value) VALUES (?, ?, ?)').run(userId(), key, value); }
export function saveTokens(tokens) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens)), cipher.final()]);
  set('tokens', Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64'));
}
export function readTokens() {
  if (!get('tokens')) return null;
  const data = Buffer.from(get('tokens'), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
}
