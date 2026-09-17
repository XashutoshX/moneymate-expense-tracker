import { randomUUID } from 'node:crypto';
import { db, userId, isPostgres, one, run } from './store.js';

export function addManualTransaction(input) {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new Error('Enter a positive amount in INR.');
  if (typeof input.merchant !== 'string' || !input.merchant.trim() || input.merchant.length > 100) throw new Error('Enter a merchant or description up to 100 characters.');
  if (!['expense', 'income', 'refund', 'transfer', 'repayment'].includes(input.type)) throw new Error('Choose a transaction type.');
  if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !Number.isFinite(Date.parse(input.date)) || new Date(input.date).toISOString().slice(0, 10) !== input.date) throw new Error('Enter a valid date.');
  if (typeof input.time !== 'string' || (input.time && !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(input.time))) throw new Error('Enter a valid time or leave it blank.');
  if (!['HDFC', 'ICICI', 'Cash', 'Other'].includes(input.bank)) throw new Error('Choose a bank or payment source.');
  if (typeof input.category !== 'string') throw new Error('Choose a category.');
  if (isPostgres) return (async () => {
    if (!await one('SELECT name FROM categories WHERE user_id=? AND name=?', [userId(), input.category])) throw new Error('Choose a category.');
    const id = 'manual-' + randomUUID();
    await run(`INSERT INTO transactions
      (user_id,id,date,merchant,amount,type,account,category,review,note,time,time_source,bank)
      VALUES (?,?,?,?,?,?,'',?,0,'',?,?,?)`, [userId(), id, input.date, input.merchant.trim(), input.amount, input.type, input.category, input.time, input.time ? 'manual' : '', input.bank]);
    return { id };
  })();
  if (!db.prepare('SELECT name FROM categories WHERE user_id=? AND name=?').get(userId(), input.category)) throw new Error('Choose a category.');
  // Separate IDs keep manual records outside Gmail's message deduplication namespace.
  const id = 'manual-' + randomUUID();
  db.prepare(`INSERT INTO transactions
    (user_id,id,date,merchant,amount,type,account,category,review,note,time,time_source,bank)
    VALUES (?,?,?,?,?,?,'',?,0,'',?,?,?)`).run(userId(),id, input.date, input.merchant.trim(), input.amount, input.type, input.category, input.time, input.time ? 'manual' : '', input.bank);
  return { id };
}
