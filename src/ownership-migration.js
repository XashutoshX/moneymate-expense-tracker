import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const LOCAL_OWNER_ID = '00000000-0000-4000-8000-000000000001';
const tables = {
  settings: 'key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(user_id,key)',
  transactions: `id TEXT NOT NULL, date TEXT NOT NULL, merchant TEXT NOT NULL,
    amount INTEGER NOT NULL, type TEXT NOT NULL, account TEXT NOT NULL,
    category TEXT NOT NULL, review INTEGER NOT NULL, note TEXT NOT NULL,
    time TEXT NOT NULL DEFAULT '', time_source TEXT NOT NULL DEFAULT '',
    bank TEXT NOT NULL DEFAULT 'HDFC', source_file TEXT NOT NULL DEFAULT '', PRIMARY KEY(user_id,id)`,
  processed: 'id TEXT NOT NULL, PRIMARY KEY(user_id,id)',
  deleted_transactions: 'id TEXT NOT NULL, PRIMARY KEY(user_id,id)',
  people: 'id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(user_id,id)',
  categories: 'name TEXT NOT NULL COLLATE NOCASE, icon TEXT NOT NULL, PRIMARY KEY(user_id,name)',
  splits: `transaction_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(user_id,transaction_id),
    FOREIGN KEY(user_id,transaction_id) REFERENCES transactions(user_id,id) ON DELETE CASCADE`
};

// Run once, atomically. VACUUM INTO captures a consistent backup including WAL data.
export function migrateOwnership(db) {
  const exists = name => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const existing = Object.keys(tables).filter(exists);
  const legacy = existing.filter(name => !db.prepare(`PRAGMA table_info(${name})`).all().some(c => c.name === 'user_id'));
  if (legacy.length && legacy.length !== existing.length) throw new Error('Mixed ownership schema; restore or review the migration before starting.');
  if (legacy.length) {
    mkdirSync('data/backups', { recursive: true });
    db.prepare('VACUUM INTO ?').run(`data/backups/before-ownership-${Date.now()}-${randomUUID()}.sqlite`);
  }
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    const userColumns = db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
    if (!userColumns.includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ); CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);`);
    db.prepare('INSERT OR IGNORE INTO users(id) VALUES (?)').run(LOCAL_OWNER_ID);
    for (const name of legacy) db.exec(`ALTER TABLE ${name} RENAME TO legacy_${name}`);
    for (const [name, definition] of Object.entries(tables)) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${name} (user_id TEXT NOT NULL REFERENCES users(id), ${definition})`);
      if (legacy.includes(name)) {
        const columns = db.prepare(`PRAGMA table_info(legacy_${name})`).all().map(c => c.name);
        const names = columns.map(c => `"${c.replaceAll('"', '""')}"`).join(',');
        db.prepare(`INSERT INTO ${name}(user_id,${names}) SELECT ?,${names} FROM legacy_${name}`).run(LOCAL_OWNER_ID);
      }
    }
    for (const name of [...legacy].reverse()) db.exec(`DROP TABLE legacy_${name}`);
    db.exec(`CREATE INDEX IF NOT EXISTS transactions_owner_date ON transactions(user_id,date DESC,id);
      CREATE INDEX IF NOT EXISTS transactions_owner_bank_date ON transactions(user_id,bank,date DESC);
      CREATE INDEX IF NOT EXISTS people_owner_name ON people(user_id,name COLLATE NOCASE)`);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Ownership migration found invalid references.');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
