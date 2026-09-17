import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
export const pool = connectionString ? new Pool({
  connectionString,
  max: Number(process.env.DATABASE_POOL_MAX || 10),
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
}) : null;

function placeholders(text) {
  let index = 0;
  return text.replace(/\?/g, () => `$${++index}`);
}

export async function query(text, params = []) {
  if (!pool) throw new Error('DATABASE_URL is required for PostgreSQL.');
  return pool.query(placeholders(text), params);
}

export async function one(text, params = []) {
  const result = await query(text, params);
  return result.rows[0];
}

export async function all(text, params = []) {
  const result = await query(text, params);
  return result.rows;
}

export async function run(text, params = []) {
  const result = await query(text, params);
  return { changes: result.rowCount };
}

export async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback({
      query: (text, params = []) => client.query(placeholders(text), params),
      one: async (text, params = []) => (await client.query(placeholders(text), params)).rows[0],
      all: async (text, params = []) => (await client.query(placeholders(text), params)).rows,
      run: async (text, params = []) => ({ changes: (await client.query(placeholders(text), params)).rowCount })
    });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function close() { if (pool) await pool.end(); }
