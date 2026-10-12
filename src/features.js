import { randomUUID } from 'node:crypto';
import { db, get, set, userId, isPostgres, all, one, run, transaction } from './store.js';
import { allocate, balances } from '../public/splits.js';

export function listTransactions() {
  if (isPostgres) return (async () => (await all(`SELECT t.*, s.data AS split_json FROM transactions t LEFT JOIN splits s ON s.user_id=t.user_id AND s.transaction_id=t.id WHERE t.user_id=? ORDER BY date DESC, time DESC, t.id DESC`, [userId()])).map(({ split_json, ...t }) => ({ ...t, split: split_json ? JSON.parse(split_json) : null })))();
  return db.prepare(`SELECT t.*, s.data AS split_json FROM transactions t LEFT JOIN splits s ON s.user_id=t.user_id AND s.transaction_id=t.id WHERE t.user_id=? ORDER BY date DESC, time DESC, t.id DESC`).all(userId())
    .map(({ split_json, ...t }) => ({ ...t, split: split_json ? JSON.parse(split_json) : null }));
}
export function deleteTransaction(id) {
  if (isPostgres) return (async () => {
    if (!await one('SELECT id FROM transactions WHERE user_id=? AND id=?', [userId(), id])) {
      if (await one('SELECT id FROM deleted_transactions WHERE user_id=? AND id=?', [userId(), id])) return { ok: true };
      return null;
    }
    await transaction(async sql => {
      await sql.run('INSERT INTO deleted_transactions(user_id,id) VALUES (?,?) ON CONFLICT DO NOTHING', [userId(), id]);
      await sql.run('DELETE FROM splits WHERE user_id=? AND transaction_id=?', [userId(), id]);
      await sql.run('DELETE FROM transactions WHERE user_id=? AND id=?', [userId(), id]);
    });
    return { ok: true };
  })();
  if (!db.prepare('SELECT id FROM transactions WHERE user_id=? AND id=?').get(userId(),id)) {
    if (db.prepare('SELECT id FROM deleted_transactions WHERE user_id=? AND id=?').get(userId(),id)) return { ok: true };
    return null;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO deleted_transactions(user_id,id) VALUES (?,?)').run(userId(),id);
    db.prepare('DELETE FROM splits WHERE user_id=? AND transaction_id=?').run(userId(),id);
    db.prepare('DELETE FROM transactions WHERE user_id=? AND id=?').run(userId(),id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { ok: true };
}
function cardList(value) {
  try { const cards = JSON.parse(value || '[]'); return Array.isArray(cards) ? cards : []; }
  catch { return []; }
}
function settlementMap(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function withSettlements(people, value) {
  const settled = settlementMap(value);
  return people.map(person => ({ ...person, settledBalance: Number.isSafeInteger(settled[person.id]) ? settled[person.id] : 0 }));
}
async function cardRequest(path, method, input) {
  const cards = cardList(await get('creditCards'));
  if (path === '/api/cards' && method === 'GET') return cards;
  if (path === '/api/cards' && method === 'POST') {
    const bank = typeof input.bank === 'string' ? input.bank.trim() : '';
    const variant = typeof input.variant === 'string' ? input.variant.trim() : '';
    const cardholderName = typeof input.cardholderName === 'string' ? input.cardholderName.trim() : '';
    const integers = ['creditLimit', 'rewardBalance', 'pointsPerUnit', 'spendUnit', 'pointValue', 'milestoneSpend', 'milestoneValue'];
    for (const field of integers) input[field] = input[field] === undefined ? 0 : input[field];
    if (!bank || bank.length > 40 || !variant || variant.length > 80 || !cardholderName || cardholderName.length > 80 ||
        cardholderName.toUpperCase().replace(/[^A-Z]/g, '').length < 4 || !/^\d{4}$/.test(input.lastFour || '') ||
        integers.some(field => !Number.isSafeInteger(input[field]) || input[field] < 0)) {
      throw new Error('Enter a valid card, name on card and last four digits.');
    }
    if (cards.some(card => card.bank.toLowerCase() === bank.toLowerCase() && card.lastFour === input.lastFour)) throw new Error('This card is already in your wallet.');
    const card = { id: randomUUID(), bank, variant, cardholderName, lastFour: input.lastFour, creditLimit: input.creditLimit,
      rewardBalance: input.rewardBalance, pointsPerUnit: input.pointsPerUnit, spendUnit: input.spendUnit,
      pointValue: input.pointValue, milestoneSpend: input.milestoneSpend, milestoneValue: input.milestoneValue };
    await set('creditCards', JSON.stringify([...cards, card]));
    return card;
  }
  if (path.startsWith('/api/cards/') && method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/api/cards/'.length));
    await set('creditCards', JSON.stringify(cards.filter(card => card.id !== id)));
    return { ok: true };
  }
}
export function featureRequest(path, method, input) {
  if (path === '/api/cards' || path.startsWith('/api/cards/')) return cardRequest(path, method, input);
  if (isPostgres) return featureRequestPostgres(path, method, input);
  if (path === '/api/profile' && method === 'GET') return {
    name: get('profileName') || '', photo: get('profilePhoto') || '', email: get('email') || '' };
  if (path === '/api/profile' && method === 'POST') {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new Error('Enter a name up to 80 characters.');
    if (typeof input.photo !== 'string' || input.photo.length > 400000 || (input.photo && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(input.photo))) throw new Error('Choose a PNG, JPEG or WebP photo under 250 KB.');
    set('profileName', input.name.trim()); set('profilePhoto', input.photo);
    return { ok: true };
  }
  if (path === '/api/people' && method === 'GET') return withSettlements(db.prepare('SELECT id,name FROM people WHERE user_id=? ORDER BY name').all(userId()), get('peopleSettlements'));
  if (path === '/api/people' && method === 'POST') {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 60) throw new Error('Enter a person name up to 60 characters.');
    if (db.prepare('SELECT id FROM people WHERE user_id=? AND name=? COLLATE NOCASE').get(userId(),name)) throw new Error('This person already exists.');
    const id = randomUUID(); db.prepare('INSERT INTO people(user_id,id,name) VALUES (?, ?, ?)').run(userId(),id,name);
    return { id, name, settledBalance: 0 };
  }
  if (path.startsWith('/api/people/') && path.endsWith('/settle') && method === 'POST') {
    const id = decodeURIComponent(path.slice('/api/people/'.length, -'/settle'.length));
    const people = db.prepare('SELECT id,name FROM people WHERE user_id=? ORDER BY name').all(userId());
    if (!people.some(person => person.id === id)) throw new Error('Person not found.');
    const settled = settlementMap(get('peopleSettlements'));
    settled[id] = balances(listTransactions(), people).get(id) || 0;
    set('peopleSettlements', JSON.stringify(settled));
    return { id, settledBalance: settled[id] };
  }
  if (path.startsWith('/api/splits/') && ['POST', 'DELETE'].includes(method)) {
    const id = decodeURIComponent(path.slice('/api/splits/'.length));
    const transaction = db.prepare('SELECT * FROM transactions WHERE user_id=? AND id=?').get(userId(),id);
    if (!transaction) throw new Error('Transaction not found.');
    if (method === 'DELETE') { db.prepare('DELETE FROM splits WHERE user_id=? AND transaction_id=?').run(userId(),id); return { ok: true }; }
    if (transaction.type !== 'expense' || transaction.review) throw new Error('Confirm this as an expense before splitting it.');
    const shares = allocate(transaction.amount, input.participants, input.mode);
    const people = new Set(db.prepare('SELECT id FROM people WHERE user_id=?').all(userId()).map(p => p.id));
    for (const share of shares) if (share.id !== 'me' && !people.has(share.id)) throw new Error('Unknown person.');
    if (input.paidBy !== 'me' && !people.has(input.paidBy)) throw new Error('Choose a known payer.');
    const split = { mode: input.mode, paidBy: input.paidBy, shares };
    db.prepare('INSERT INTO splits(user_id,transaction_id,data) VALUES (?, ?, ?) ON CONFLICT(user_id,transaction_id) DO UPDATE SET data=excluded.data').run(userId(),id,JSON.stringify(split));
    return split;
  }
}

async function featureRequestPostgres(path, method, input) {
  if (path === '/api/profile' && method === 'GET') return { name: await get('profileName') || '', photo: await get('profilePhoto') || '', email: await get('email') || '' };
  if (path === '/api/profile' && method === 'POST') {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new Error('Enter a name up to 80 characters.');
    if (typeof input.photo !== 'string' || input.photo.length > 400000 || (input.photo && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(input.photo))) throw new Error('Choose a PNG, JPEG or WebP photo under 250 KB.');
    await set('profileName', input.name.trim()); await set('profilePhoto', input.photo); return { ok: true };
  }
  if (path === '/api/people' && method === 'GET') return withSettlements(await all('SELECT id,name FROM people WHERE user_id=? ORDER BY name', [userId()]), await get('peopleSettlements'));
  if (path === '/api/people' && method === 'POST') {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 60) throw new Error('Enter a person name up to 60 characters.');
    if (await one('SELECT id FROM people WHERE user_id=? AND LOWER(name)=LOWER(?)', [userId(), name])) throw new Error('This person already exists.');
    const id = randomUUID(); await run('INSERT INTO people(user_id,id,name) VALUES (?,?,?)', [userId(), id, name]); return { id, name, settledBalance: 0 };
  }
  if (path.startsWith('/api/people/') && path.endsWith('/settle') && method === 'POST') {
    const id = decodeURIComponent(path.slice('/api/people/'.length, -'/settle'.length));
    const people = await all('SELECT id,name FROM people WHERE user_id=? ORDER BY name', [userId()]);
    if (!people.some(person => person.id === id)) throw new Error('Person not found.');
    const settled = settlementMap(await get('peopleSettlements'));
    settled[id] = balances(await listTransactions(), people).get(id) || 0;
    await set('peopleSettlements', JSON.stringify(settled));
    return { id, settledBalance: settled[id] };
  }
  if (path.startsWith('/api/splits/') && ['POST', 'DELETE'].includes(method)) {
    const id = decodeURIComponent(path.slice('/api/splits/'.length));
    const transaction = await one('SELECT * FROM transactions WHERE user_id=? AND id=?', [userId(), id]);
    if (!transaction) throw new Error('Transaction not found.');
    if (method === 'DELETE') { await run('DELETE FROM splits WHERE user_id=? AND transaction_id=?', [userId(), id]); return { ok: true }; }
    if (transaction.type !== 'expense' || transaction.review) throw new Error('Confirm this as an expense before splitting it.');
    const shares = allocate(Number(transaction.amount), input.participants, input.mode);
    const people = new Set((await all('SELECT id FROM people WHERE user_id=?', [userId()])).map(p => p.id));
    for (const share of shares) if (share.id !== 'me' && !people.has(share.id)) throw new Error('Unknown person.');
    if (input.paidBy !== 'me' && !people.has(input.paidBy)) throw new Error('Choose a known payer.');
    const split = { mode: input.mode, paidBy: input.paidBy, shares };
    await run('INSERT INTO splits(user_id,transaction_id,data) VALUES (?,?,?) ON CONFLICT(user_id,transaction_id) DO UPDATE SET data=EXCLUDED.data', [userId(), id, JSON.stringify(split)]); return split;
  }
}
