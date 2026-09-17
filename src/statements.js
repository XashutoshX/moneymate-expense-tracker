import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { db, userId, isPostgres, all, one, run, transaction } from './store.js';
import { classify } from './categories.js';
import { MAX_ROWS, normalizeRows, parseDate } from './statement-parser.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const staged = new Map();
let extracting = false;
const hash = value => createHash('sha256').update(value).digest('hex');
function stage(token) {
  for (const [key, value] of staged) if (value.expires < Date.now()) staged.delete(key);
  const value = staged.get(token);
  if (!value) throw new Error('This preview expired or the server restarted. Upload the statement again.');
  return value;
}
function settings(input) {
  if (!['HDFC', 'ICICI', 'Other'].includes(input.bank)) throw new Error('Choose the statement bank.');
  if (typeof input.account !== 'string' || !/^(?:\d{4})?$/.test(input.account)) throw new Error('Enter the last four account or card digits, or leave them blank.');
}
export async function uploadStatement(input) {
  if (typeof input.name !== 'string' || input.name.length > 200 || !/\.(pdf|csv|xlsx?)$/i.test(input.name)) throw new Error('Choose a PDF, CSV, XLS or XLSX statement.');
  if (typeof input.data !== 'string' || input.data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || input.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new Error('Choose a valid file up to 10 MB.');
  const data = Buffer.from(input.data, 'base64');
  if (!data.length || data.length > MAX_FILE_BYTES) throw new Error('Choose a nonempty file up to 10 MB.');
  if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length > 256)) throw new Error('Password is too long.');
  if (extracting) throw new Error('Another statement is being read. Please try again shortly.');
  extracting = true;
  try {
    // Parsing untrusted binary files off-thread keeps the local app responsive.
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./statement-extract.js', import.meta.url), { execArgv: [], workerData: { name: input.name, data, password: input.password || '' }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('Reading the statement took too long. Try a smaller file.')); }, 30000);
      worker.once('message', value => { clearTimeout(timer); worker.terminate(); value.error ? reject(new Error(value.error)) : resolve(value); });
      worker.once('error', () => { clearTimeout(timer); reject(new Error('Could not read the statement. Try a smaller file or export CSV.')); });
      worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('Statement reader stopped. Try a smaller file or export CSV.')); });
    });
    for (const [key, value] of staged) if (value.expires < Date.now()) staged.delete(key);
    while (staged.size >= 3) staged.delete(staged.keys().next().value);
    const token = randomUUID();
    // File bytes and passwords are not retained. Only the extracted table is staged.
    staged.set(token, { ...result, name: input.name.replace(/^.*[\\/]/, ''), hash: hash(data), expires: Date.now() + 30 * 60000 });
    return { token, sheets: result.sheets.map(({ rows, ...sheet }) => ({ ...sheet, rowCount: rows.length, width: Math.max(...rows.map(row => row.length)), sample: rows.slice(0, 100) })) };
  } finally { extracting = false; }
}
function sourceId(entry, sheetIndex, rowIndex) { return 'statement-' + hash(`${entry.hash}:${sheetIndex}:${rowIndex}`); }
function sheetFor(entry, index) {
  if (!Number.isInteger(index) || index < 0 || !entry.sheets[index]) throw new Error('Choose a worksheet.');
  return entry.sheets[index];
}
export function previewStatement(input) {
  settings(input);
  if (isPostgres) return (async () => {
    const entry = stage(input.token), sheet = sheetFor(entry, input.sheetIndex), result = normalizeRows(sheet.rows, input);
    const existing = await all('SELECT id,date,amount,type,bank,account FROM transactions WHERE user_id=?', [userId()]);
    const ids = new Set(existing.map(row => row.id));
    for (const row of await all('SELECT id FROM deleted_transactions WHERE user_id=?', [userId()])) ids.add(row.id);
    const similar = new Map();
    for (const row of existing) { const key = `${row.date}:${row.amount}:${row.type}:${row.bank}`; const values = similar.get(key) || []; values.push(row); similar.set(key, values); }
    const seen = new Set();
    return { ...result, rows: result.rows.map(row => {
      const key = `${row.date}:${row.amount}:${row.type}:${input.bank}`;
      const duplicate = ids.has(sourceId(entry, input.sheetIndex, row.rowIndex));
      const possibleDuplicate = !duplicate && (seen.has(key) || (similar.get(key) || []).some(value => !input.account || !value.account || value.account === input.account));
      seen.add(key); return { ...row, category: classify(row, false).category, duplicate, possibleDuplicate };
    }) };
  })();
  const entry = stage(input.token), sheet = sheetFor(entry, input.sheetIndex);
  const result = normalizeRows(sheet.rows, input);
  const existing = db.prepare('SELECT id,date,amount,type,bank,account FROM transactions WHERE user_id=?').all(userId());
  const ids = new Set(existing.map(row => row.id));
  for (const row of db.prepare('SELECT id FROM deleted_transactions WHERE user_id=?').all(userId())) ids.add(row.id);
  const similar = new Map();
  for (const row of existing) {
    const key = `${row.date}:${row.amount}:${row.type}:${row.bank}`;
    const values = similar.get(key) || []; values.push(row); similar.set(key, values);
  }
  const seen = new Set();
  return { ...result, rows: result.rows.map(row => {
    const key = `${row.date}:${row.amount}:${row.type}:${input.bank}`;
    const duplicate = ids.has(sourceId(entry, input.sheetIndex, row.rowIndex));
    const possibleDuplicate = !duplicate && (seen.has(key) || (similar.get(key) || []).some(value => !input.account || !value.account || value.account === input.account));
    seen.add(key);
    return { ...row, category: classify(row, false).category, duplicate, possibleDuplicate };
  }) };
}
export function commitStatement(input) {
  settings(input);
  if (isPostgres) return commitStatementPostgres(input);
  const entry = stage(input.token), sheet = sheetFor(entry, input.sheetIndex);
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > MAX_ROWS) throw new Error('Select between 1 and 5,000 transactions.');
  const rowNumbers = new Set();
  for (const row of input.rows) {
    if (!row || !Number.isInteger(row.rowIndex) || row.rowIndex < 0 || row.rowIndex >= sheet.rows.length || rowNumbers.has(row.rowIndex)) throw new Error('Invalid or repeated statement row.');
    rowNumbers.add(row.rowIndex);
    if (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || parseDate(row.date) !== row.date || !Number.isSafeInteger(row.amount) || row.amount <= 0 || typeof row.merchant !== 'string' || !row.merchant.trim() || row.merchant.length > 100 || !['expense', 'income', 'refund', 'transfer', 'repayment'].includes(row.type)) throw new Error(`Check the date, description, amount and type on row ${row.rowIndex + 1}.`);
    if (typeof row.category !== 'string' || !db.prepare('SELECT name FROM categories WHERE user_id=? AND name=?').get(userId(), row.category)) throw new Error(`Choose a category on row ${row.rowIndex + 1}.`);
  }
  let imported = 0, skipped = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare(`INSERT OR IGNORE INTO transactions
      (user_id,id,date,merchant,amount,type,account,category,review,note,time,time_source,bank,source_file)
      VALUES (?,?,?,?,?,?,?, ?,0,?,'','',?,?)`);
    for (const row of input.rows) {
      if (db.prepare('SELECT id FROM deleted_transactions WHERE user_id=? AND id=?').get(userId(), sourceId(entry, input.sheetIndex, row.rowIndex))) { skipped++; continue; }
      const result = insert.run(userId(), sourceId(entry, input.sheetIndex, row.rowIndex), row.date, row.merchant.trim(), row.amount, row.type, input.account, row.category,
        `Reviewed statement import, ${sheet.name}, row ${row.rowIndex + 1}.`, input.bank, entry.name);
      if (result.changes) imported++; else skipped++;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { imported, skipped };
}

async function commitStatementPostgres(input) {
  const entry = stage(input.token), sheet = sheetFor(entry, input.sheetIndex);
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > MAX_ROWS) throw new Error('Select between 1 and 5,000 transactions.');
  const rowNumbers = new Set();
  for (const row of input.rows) {
    if (!row || !Number.isInteger(row.rowIndex) || row.rowIndex < 0 || row.rowIndex >= sheet.rows.length || rowNumbers.has(row.rowIndex)) throw new Error('Invalid or repeated statement row.');
    rowNumbers.add(row.rowIndex);
    if (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || parseDate(row.date) !== row.date || !Number.isSafeInteger(row.amount) || row.amount <= 0 || typeof row.merchant !== 'string' || !row.merchant.trim() || row.merchant.length > 100 || !['expense', 'income', 'refund', 'transfer', 'repayment'].includes(row.type)) throw new Error(`Check the date, description, amount and type on row ${row.rowIndex + 1}.`);
    if (typeof row.category !== 'string' || !await one('SELECT name FROM categories WHERE user_id=? AND name=?', [userId(), row.category])) throw new Error(`Choose a category on row ${row.rowIndex + 1}.`);
  }
  let imported = 0, skipped = 0;
  await transaction(async sql => {
    for (const row of input.rows) {
      const id = sourceId(entry, input.sheetIndex, row.rowIndex);
      if (await sql.one('SELECT id FROM deleted_transactions WHERE user_id=? AND id=?', [userId(), id])) { skipped++; continue; }
      const result = await sql.run(`INSERT INTO transactions
        (user_id,id,date,merchant,amount,type,account,category,review,note,time,time_source,bank,source_file)
        VALUES (?,?,?,?,?,?,?,?,0,?,'','',?,?) ON CONFLICT(user_id,id) DO NOTHING`, [userId(), id, row.date, row.merchant.trim(), row.amount, row.type, input.account, row.category, `Reviewed statement import, ${sheet.name}, row ${row.rowIndex + 1}.`, input.bank, entry.name]);
      if (result.changes) imported++; else skipped++;
    }
  });
  return { imported, skipped };
}
export function discardStatement(token) { staged.delete(token); return { ok: true }; }
