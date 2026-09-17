import { readTokens, saveTokens, get, set, one, run, userId } from './store.js';
import { messageText } from './parser.js';
import { bankFromSender, parseBank } from './banks.js';
import { gmailError } from './google-errors.js';
import { classify } from './categories.js';

export const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${process.env.APP_ORIGIN || 'http://localhost:3000'}/auth/callback`;
export const configured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const quotaRetries = 4;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function quotaLimited(status, payload) {
  const error = payload?.error || {};
  const evidence = JSON.stringify(error);
  return status === 429 || /quota|rateLimit|RESOURCE_EXHAUSTED|userRateLimitExceeded/i.test(evidence);
}
export async function exchange(params) {
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    body: new URLSearchParams({ ...params, client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET }), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Google authorization failed. Connect Gmail again.');
  const tokens = await response.json();
  return { ...tokens, expires_at: Date.now() + tokens.expires_in * 1000 };
}
async function accessToken() {
  let tokens = await readTokens();
  if (!tokens) throw new Error('Connect Gmail first.');
  if (tokens.expires_at < Date.now() + 60000) {
    tokens = { ...tokens, ...await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }) };
    await saveTokens(tokens);
  }
  return tokens.access_token;
}
export async function gmail(path, token) {
  const access = token || await accessToken();
  for (let attempt = 0; ; attempt++) {
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path,
      { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(30000) });
    if (response.ok) return response.json();
    const payload = await response.json().catch(() => ({}));
    const retryable = quotaLimited(response.status, payload);
    console.error('[Gmail API error]', { status: response.status, path: path.split('?')[0], attempt: attempt + 1, retrying: retryable && attempt < quotaRetries, error: payload.error || payload });
    if (!retryable || attempt >= quotaRetries) throw new Error(gmailError(response.status, payload));
    const retryAfter = Number(response.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
    await wait(Math.min(delay, 30000));
  }
}
export async function sync() {
  const startedAt = Date.now();
  // Backfill once when adding a sender so an existing sync cursor cannot hide older alerts.
  const reparse = await get('parserVersion') !== '5';
  const backfillTime = await get('timeVersion') !== '1';
  const lastSync = await get('senderVersion') === '4' && !reparse && !backfillTime ? Number(await get('lastSync')) : 0;
  const after = Math.floor((lastSync || startedAt - 90 * 86400000) / 1000) - 2 * 86400;
  const query = `{from:hdfcbank.net from:hdfcbank.com from:alerts@hdfcbank.bank.in from:icici.bank.in from:credit_cards@icici.bank.in from:cbsalerts.sbi@alerts.sbi.bank.in} after:${after} {debited credited spent purchase paid withdrawn refund reversed}`;
  let pageToken = '', imported = 0, skipped = 0;
  do {
    const page = await gmail('messages?' + new URLSearchParams({ q: query, maxResults: '100', ...(pageToken ? { pageToken } : {}) }));
    for (const { id } of page.messages || []) {
      if (await one('SELECT id FROM deleted_transactions WHERE user_id=? AND id=?', [userId(), id])) continue;
      const existing = await one('SELECT review FROM transactions WHERE user_id=? AND id=?', [userId(), id]);
      if (await one('SELECT id FROM processed WHERE user_id=? AND id=?', [userId(), id]) && !(reparse && (!existing || existing.review)) && !backfillTime) continue;
      const message = await gmail(`messages/${id}?format=full`);
      // The user may delete this entry while the Gmail request is in flight.
      if (await one('SELECT id FROM deleted_transactions WHERE user_id=? AND id=?', [userId(), id])) continue;
      const sender = message.payload.headers?.find(h => h.name.toLowerCase() === 'from')?.value || '';
      const bank = bankFromSender(sender);
      const parsed = bank ? parseBank(bank, messageText(message.payload), Number(message.internalDate)) : null;
      const transaction = parsed ? classify(parsed, await get('autoReview') !== 'false') : null;
      if (transaction) {
        await run(`INSERT INTO transactions
          (user_id, id, date, merchant, amount, type, account, category, review, note, bank)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id,id) DO UPDATE SET date=excluded.date, merchant=excluded.merchant,
            amount=excluded.amount, type=excluded.type, account=excluded.account, note=excluded.note,
            category=excluded.category, review=excluded.review
          WHERE transactions.review=1`, [userId(), id, transaction.date, transaction.merchant, transaction.amount, transaction.type, transaction.account,
          transaction.category, transaction.review, transaction.note, bank]);
        imported++;
        // Enrich old records without replacing confirmed dates, amounts or categories.
        if (transaction.time) await run("UPDATE transactions SET time=?, time_source=? WHERE user_id=? AND id=? AND time=''", [transaction.time, transaction.timeSource, userId(), id]);
      } else skipped++;
      await run('INSERT INTO processed(user_id,id) VALUES (?,?) ON CONFLICT DO NOTHING', [userId(), id]);
    }
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  await set('lastSync', String(startedAt));
  await set('senderVersion', '4');
  await set('parserVersion', '5');
  await set('timeVersion', '1');
  return { imported, skipped };
}
