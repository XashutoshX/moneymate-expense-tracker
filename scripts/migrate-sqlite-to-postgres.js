if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before running the migration.');
const { db } = await import('../src/store.js');
const { migratePostgres } = await import('../src/postgres-schema.js');
const { transaction } = await import('../src/postgres.js');
await migratePostgres();
const tables = ['users', 'settings', 'transactions', 'processed', 'deleted_transactions', 'people', 'categories', 'splits', 'sessions'];
const rows = Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM ${name}`).all()]));
await transaction(async sql => {
  for (const row of rows.users) await sql.run('INSERT INTO users(id,email,created_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email', [row.id, row.email || null, row.created_at]);
  for (const row of rows.settings) await sql.run('INSERT INTO settings(user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=EXCLUDED.value', [row.user_id, row.key, row.value]);
  for (const row of rows.transactions) await sql.run(`INSERT INTO transactions
    (user_id,id,date,merchant,amount,type,account,category,review,note,time,time_source,bank,source_file)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO NOTHING`, [row.user_id, row.id, row.date, row.merchant, row.amount, row.type, row.account, row.category, row.review, row.note, row.time, row.time_source, row.bank, row.source_file]);
  for (const table of ['processed', 'deleted_transactions']) for (const row of rows[table]) await sql.run(`INSERT INTO ${table}(user_id,id) VALUES (?,?) ON CONFLICT DO NOTHING`, [row.user_id, row.id]);
  for (const row of rows.people) await sql.run('INSERT INTO people(user_id,id,name) VALUES (?,?,?) ON CONFLICT DO NOTHING', [row.user_id, row.id, row.name]);
  for (const row of rows.categories) await sql.run('INSERT INTO categories(user_id,name,icon) VALUES (?,?,?) ON CONFLICT DO NOTHING', [row.user_id, row.name, row.icon]);
  for (const row of rows.splits) await sql.run('INSERT INTO splits(user_id,transaction_id,data) VALUES (?,?,?) ON CONFLICT DO NOTHING', [row.user_id, row.transaction_id, row.data]);
  for (const row of rows.sessions) await sql.run('INSERT INTO sessions(id_hash,user_id,expires_at,created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING', [row.id_hash, row.user_id, row.expires_at, row.created_at]);
});
db.close();
process.stdout.write(`Migrated ${rows.transactions.length} transactions for ${rows.users.length} users.\n`);
