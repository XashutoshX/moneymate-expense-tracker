import { query } from './postgres.js';
import { defaultCategories } from './categories.js';

export async function migratePostgres() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS settings (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY(user_id,key)
    );
    CREATE TABLE IF NOT EXISTS transactions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      date TEXT NOT NULL,
      merchant TEXT NOT NULL,
      amount BIGINT NOT NULL,
      type TEXT NOT NULL,
      account TEXT NOT NULL,
      category TEXT NOT NULL,
      review INTEGER NOT NULL,
      note TEXT NOT NULL,
      time TEXT NOT NULL DEFAULT '',
      time_source TEXT NOT NULL DEFAULT '',
      bank TEXT NOT NULL DEFAULT 'HDFC',
      source_file TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(user_id,id)
    );
    CREATE INDEX IF NOT EXISTS transactions_owner_date ON transactions(user_id,date DESC,id);
    CREATE INDEX IF NOT EXISTS transactions_owner_bank_date ON transactions(user_id,bank,date DESC);
    CREATE TABLE IF NOT EXISTS processed (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      PRIMARY KEY(user_id,id)
    );
    CREATE TABLE IF NOT EXISTS deleted_transactions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      PRIMARY KEY(user_id,id)
    );
    CREATE TABLE IF NOT EXISTS people (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      PRIMARY KEY(user_id,id)
    );
    CREATE INDEX IF NOT EXISTS people_owner_name ON people(user_id,name);
    CREATE TABLE IF NOT EXISTS categories (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      icon TEXT NOT NULL,
      PRIMARY KEY(user_id,name)
    );
    CREATE TABLE IF NOT EXISTS splits (
      user_id TEXT NOT NULL,
      transaction_id TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY(user_id,transaction_id),
      FOREIGN KEY(user_id,transaction_id) REFERENCES transactions(user_id,id) ON DELETE CASCADE
    );
  `);
  const owner = await (await query('SELECT id FROM users WHERE id=?', ['00000000-0000-4000-8000-000000000001'])).rows[0];
  if (owner) {
    for (const [name, icon] of defaultCategories) await query('INSERT INTO categories(user_id,name,icon) VALUES (?,?,?) ON CONFLICT DO NOTHING', [owner.id, name, icon]);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  await migratePostgres();
  process.stdout.write('PostgreSQL schema is ready.\n');
}
