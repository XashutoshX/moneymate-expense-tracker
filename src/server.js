import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { db, get, set, saveTokens, readTokens, userId, enterUser, findOrCreateUser, createSession, sessionUser, deleteSession } from './store.js';
import { configured, redirectUri, exchange, gmail, sync } from './gmail.js';
import { categoryIcons } from './categories.js';
import { deleteTransaction, featureRequest, listTransactions } from './features.js';
import { addManualTransaction } from './manual.js';
import { createPeoplePdf } from './people-pdf.js';
import { uploadStatement, previewStatement, commitStatement, discardStatement, MAX_FILE_BYTES } from './statements.js';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be between 1024 and 65535.');
const origin = `http://localhost:${port}`;
const csrf = randomBytes(32).toString('hex');
const pending = new Map();
let syncing = false;
const cookie = (req, name) => req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) || '';
const sessionCookie = token => `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`;
function requireSession(req) {
  const id = sessionUser(cookie(req, 'session'));
  if (!id) { const error = new Error('Sign in with Google to continue.'); error.status = 401; throw error; }
  return id;
}
function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
function redirect(res, location) { res.writeHead(302, { Location: location }); res.end(); }
function requireConnected() { if (!get('tokens')) throw new Error('Gmail is disconnected. Reconnect to view your data.'); }
async function body(req, limit = 450000) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > limit) throw new Error('Request too large.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  // Loopback binding, host validation and same-origin mutations protect the local service.
  if (req.headers.host !== `localhost:${port}`) return json(res, { error: 'Invalid host.' }, 403);
  const url = new URL(req.url, origin);
  try {
    const authenticatedUser = sessionUser(cookie(req, 'session'));
    const publicPath = ['/', '/app.js', '/api.js', '/statements.js', '/features.js', '/sneezy.js', '/splits.js', '/styles.css', '/transaction-delete.js', '/analytics.js'].includes(url.pathname);
    const publicRoute = publicPath || url.pathname === '/auth/connect' || url.pathname === '/auth/callback' || (url.pathname === '/api/status' && req.method === 'GET');
    if (!publicRoute) enterUser(requireSession(req));
    else if (authenticatedUser) enterUser(authenticatedUser);
    if (req.method !== 'GET') {
      if (req.headers.origin !== origin) return json(res, { code: 'INVALID_ORIGIN', error: `Open the app at ${origin} to save changes.` }, 403);
      if (req.headers['x-csrf-token'] !== csrf) return json(res, { code: 'CSRF_EXPIRED', error: 'The server restarted. Refresh the page and try again.' }, 403);
    }
    if (url.pathname === '/api/status' && req.method === 'GET') return json(res, {
      authenticated: Boolean(authenticatedUser), csrf, configured: configured(), connected: Boolean(authenticatedUser && get('tokens')), email: authenticatedUser ? get('email') : '', lastSync: authenticatedUser ? get('lastSync') : '', syncing: Boolean(authenticatedUser && syncing), autoReview: authenticatedUser ? get('autoReview') !== 'false' : true });
    if (url.pathname === '/api/statements/upload' && req.method === 'POST') return json(res, await uploadStatement(await body(req, Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4096)));
    if (url.pathname === '/api/statements/preview' && req.method === 'POST') return json(res, previewStatement(await body(req)));
    if (url.pathname === '/api/statements/commit' && req.method === 'POST') return json(res, commitStatement(await body(req, 5 * 1024 * 1024)));
    if (url.pathname === '/api/statements/discard' && req.method === 'POST') return json(res, discardStatement((await body(req)).token));
    if (['/api/profile', '/api/people'].includes(url.pathname) || url.pathname.startsWith('/api/splits/')) {
      const result = featureRequest(url.pathname, req.method, req.method === 'POST' ? await body(req) : {});
      if (result !== undefined) return json(res, result);
    }
    if (url.pathname === '/api/categories' && req.method === 'GET') { return json(res, {
      categories: db.prepare('SELECT name,icon FROM categories WHERE user_id=? ORDER BY name').all(userId()), icons: categoryIcons });
    }
    if (url.pathname === '/api/categories' && req.method === 'POST') {
      const input = await body(req);
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 60 || !categoryIcons.includes(input.icon)) throw new Error('Enter a category name (up to 60 characters) and choose an icon.');
      if (db.prepare('SELECT name FROM categories WHERE user_id=? AND name=?').get(userId(), name)) throw new Error('That category already exists.');
      db.prepare('INSERT INTO categories(user_id,name,icon) VALUES (?, ?, ?)').run(userId(), name, input.icon);
      return json(res, { name, icon: input.icon }, 201);
    }
    if (url.pathname === '/api/auto-review' && req.method === 'POST') {
      requireConnected();
      const input = await body(req);
      if (typeof input.enabled !== 'boolean') throw new Error('Invalid auto-review setting.');
      set('autoReview', String(input.enabled));
      if (input.enabled) set('parserVersion', '');
      return json(res, { ok: true });
    }
    if (url.pathname === '/auth/connect' && req.method === 'GET') {
      if (!configured()) return redirect(res, '/?error=Configure%20Google%20credentials%20in%20.env%20first.');
      const state = randomBytes(32).toString('hex'), verifier = randomBytes(48).toString('base64url');
      for (const [key, value] of pending) if (value.until < Date.now()) pending.delete(key);
      pending.set(state, { verifier, until: Date.now() + 600000 });
      res.setHeader('Set-Cookie', `oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600`);
      return redirect(res, 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code',
        scope: 'https://www.googleapis.com/auth/gmail.readonly', access_type: 'offline', prompt: 'consent',
        state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }));
    }
    if (url.pathname === '/auth/callback' && req.method === 'GET') {
      const state = url.searchParams.get('state'), entry = pending.get(state);
      pending.delete(state);
      if (!entry || entry.until < Date.now() || !req.headers.cookie?.split('; ').includes(`oauth_state=${state}`)) throw new Error('Sign-in expired. Please connect again.');
      res.setHeader('Set-Cookie', 'oauth_state=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0');
      if (url.searchParams.has('error')) throw new Error('Gmail permission was not granted.');
      const tokens = await exchange({ code: url.searchParams.get('code'), grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: entry.verifier });
      const profile = await gmail('profile', tokens.access_token);
      if (!tokens.refresh_token) throw new Error('No offline token was issued. Reconnect and grant access.');
      const id = findOrCreateUser(profile.emailAddress);
      enterUser(id); saveTokens(tokens); set('email', profile.emailAddress);
      res.setHeader('Set-Cookie', [sessionCookie(createSession(id)), 'oauth_state=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0']);
      return redirect(res, '/');
    }
    if (url.pathname === '/api/export/people.pdf' && req.method === 'GET') {
      const pdf = await createPeoplePdf(listTransactions(), featureRequest('/api/people', 'GET'), get('profileName') || '');
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="moneymante-people-balances.pdf"' });
      return res.end(pdf);
    }
    if (url.pathname === '/api/transactions' && req.method === 'GET') { return json(res, listTransactions()); }
    if (url.pathname === '/api/transactions' && req.method === 'POST') { return json(res, addManualTransaction(await body(req)), 201); }
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      requireConnected();
      if (syncing) return json(res, { error: 'A sync is already running.' }, 409);
      syncing = true;
      try { return json(res, await sync()); } finally { syncing = false; }
    }
    if (url.pathname === '/api/disconnect' && req.method === 'POST') {
      if (syncing) throw new Error('Wait for the sync to finish.');
      const tokens = readTokens();
      if (tokens) {
        const response = await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token: tokens.refresh_token || tokens.access_token }), signal: AbortSignal.timeout(30000) });
        if (!response.ok && response.status !== 400) throw new Error('Google could not revoke access. Please retry.');
      }
      db.prepare("DELETE FROM settings WHERE user_id=? AND key='tokens'").run(userId());
      return json(res, { ok: true });
    }
    if (url.pathname === '/auth/logout' && req.method === 'GET') {
      deleteSession(cookie(req, 'session'));
      res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return redirect(res, '/');
    }
    if (url.pathname.startsWith('/api/transactions/') && req.method === 'DELETE') {
      const result = deleteTransaction(decodeURIComponent(url.pathname.slice('/api/transactions/'.length)));
      return result ? json(res, result) : json(res, { error: 'Transaction not found.' }, 404);
    }
    if (url.pathname.startsWith('/api/transactions/') && req.method === 'PATCH') {
      const id = url.pathname.split('/').pop(), input = await body(req);
      if (!db.prepare('SELECT id FROM transactions WHERE user_id=? AND id=?').get(userId(), id)) return json(res, { error: 'Transaction not found.' }, 404);
      const previous = db.prepare('SELECT amount, type FROM transactions WHERE user_id=? AND id=?').get(userId(), id);
      if (db.prepare('SELECT transaction_id FROM splits WHERE user_id=? AND transaction_id=?').get(userId(), id) && (previous.amount !== input.amount || input.type !== 'expense')) throw new Error('Remove the split before changing its amount or transaction type.');
      if (input.time !== undefined && (typeof input.time !== 'string' || (input.time && !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(input.time)))) throw new Error('Enter a valid transaction time.');
      if (!db.prepare('SELECT name FROM categories WHERE user_id=? AND name=?').get(userId(), input.category)) throw new Error('Choose an existing category or add a new one first.');
      if (!['expense', 'income', 'refund', 'transfer', 'repayment', 'ignored'].includes(input.type) ||
          !Number.isSafeInteger(input.amount) || input.amount <= 0 || typeof input.merchant !== 'string' || !input.merchant.trim() || input.merchant.length > 100 ||
          typeof input.category !== 'string' || input.category.length > 60 || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
          !Number.isFinite(Date.parse(input.date)) || new Date(input.date).toISOString().slice(0, 10) !== input.date) throw new Error('Enter a valid date, amount, merchant and type.');
      db.prepare('UPDATE transactions SET date=?, merchant=?, amount=?, type=?, category=?, review=0, note=? WHERE user_id=? AND id=?').run(input.date, input.merchant.trim(), input.amount, input.type, input.category || 'Uncategorized', '', userId(), id);
      if (input.time !== undefined) db.prepare('UPDATE transactions SET time=?, time_source=? WHERE user_id=? AND id=?').run(input.time, input.time ? 'manual' : '', userId(), id);
      return json(res, { ok: true });
    }
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/api.js': ['api.js', 'text/javascript'], '/statements.js': ['statements.js', 'text/javascript'], '/features.js': ['features.js', 'text/javascript'], '/sneezy.js': ['sneezy.js', 'text/javascript'], '/splits.js': ['splits.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
    files['/transaction-delete.js'] = ['transaction-delete.js', 'text/javascript'];
    files['/analytics.js'] = ['analytics.js', 'text/javascript'];
    if (req.method === 'GET' && files[url.pathname]) {
      const [file, mime] = files[url.pathname];
      res.setHeader('Content-Type', mime); return res.end(await readFile(new URL('../public/' + file, import.meta.url)));
    }
    return json(res, { error: 'Not found.' }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed.';
    if (url.pathname === '/auth/callback') return redirect(res, '/?error=' + encodeURIComponent(message));
    json(res, { error: message }, error?.status || 400);
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Expense tracker: ${origin}`));
