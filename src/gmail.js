import { readTokens, saveTokens, get, set, one, run, userId } from './store.js';
import { messageText } from './parser.js';
import { bankFromSender, parseBank } from './banks.js';
import { gmailError } from './google-errors.js';
import { classify } from './categories.js';

export const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${process.env.APP_ORIGIN || 'http://localhost:3000'}/auth/callback`;
export const configured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const quotaRetries = 4;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function googleFetch(url, options, service) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fetch(url, options); }
    catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      console.error('[Google network error]', { service, attempt: attempt + 1, retrying: !timeout && attempt < 2, error: error?.cause?.code || error?.name || 'unknown' });
      if (!timeout && attempt < 2) { await wait(250 * 2 ** attempt); continue; }
      const failure = new Error(timeout ? `${service} timed out. Please retry.` : `Could not reach ${service}. Check the server internet connection and retry.`);
      failure.status = 502;
      throw failure;
    }
  }
}
function quotaLimited(status, payload) {
  const error = payload?.error || {};
  const evidence = JSON.stringify(error);
  return status === 429 || /quota|rateLimit|RESOURCE_EXHAUSTED|userRateLimitExceeded/i.test(evidence);
}
export async function exchange(params) {
  const response = await googleFetch('https://oauth2.googleapis.com/token', { method: 'POST',
    body: new URLSearchParams({ ...params, client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET }), signal: AbortSignal.timeout(30000) }, 'Google authorization');
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
    const response = await googleFetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path,
      { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(30000) }, 'Gmail');
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

const HDFC_STATEMENT_SENDER = 'emailstatements.cards@hdfcbank.bank.in';
function header(payload, name) {
  return payload.headers?.find(item => item.name.toLowerCase() === name.toLowerCase())?.value || '';
}
function senderAddress(value) {
  return (value.match(/<([^>]+)>/)?.[1] || value).trim().toLowerCase();
}
function parts(payload) {
  return [payload, ...(payload.parts || []).flatMap(parts)];
}
export function hdfcStatementPassword(cardholderName, lastFour, dobDayMonth = '') {
  const name = String(cardholderName || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (name.length < 4 || !/^\d{4}$/.test(lastFour || '')) throw new Error('Enter the name printed on the card and its last four digits.');
  if (dobDayMonth && !/^(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])$/.test(dobDayMonth)) throw new Error('Enter date of birth as DDMM.');
  return `${name.slice(0, 4)}${dobDayMonth || lastFour}`;
}
export async function findHdfcCardStatement(lastFour) {
  if (!/^\d{4}$/.test(lastFour || '')) throw new Error('Enter the card\'s last four digits.');
  const query = `from:${HDFC_STATEMENT_SENDER} has:attachment filename:pdf ${lastFour} newer_than:2y`;
  const page = await gmail('messages?' + new URLSearchParams({ q: query, maxResults: '25' }));
  for (const { id } of page.messages || []) {
    const message = await gmail(`messages/${id}?format=full`);
    if (senderAddress(header(message.payload, 'from')) !== HDFC_STATEMENT_SENDER) continue;
    const pdfs = parts(message.payload).filter(part => part.filename && /\.pdf$/i.test(part.filename) && (part.body?.attachmentId || part.body?.data));
    const searchable = [header(message.payload, 'subject'), messageText(message.payload), ...pdfs.map(part => part.filename)].join(' ');
    if (!new RegExp(`(?:^|\\D)${lastFour}(?:\\D|$)`).test(searchable)) continue;
    const part = pdfs[0];
    if (!part) continue;
    const attachment = part.body.data ? part.body : await gmail(`messages/${id}/attachments/${encodeURIComponent(part.body.attachmentId)}`);
    if (!attachment.data) continue;
    const data = Buffer.from(attachment.data, 'base64url');
    return { name: part.filename.replace(/^.*[\\/]/, ''), data: data.toString('base64'), messageId: id };
  }
  throw new Error(`No HDFC card-statement PDF matching card ending ${lastFour} was found in the last two years.`);
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
