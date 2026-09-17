import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../public/api.js';
const response = (status, data) => ({ status, ok: status === 200, json: async () => data });
test('expired token refreshes once and retries the unchanged save', async () => {
  const calls = [];
  const api = createApi(async (path, options) => {
    calls.push({ path, options });
    if (path === '/api/status') return response(200, { csrf: 'fresh' });
    return options.headers['X-CSRF-Token'] === 'fresh' ? response(200, { ok: true }) : response(403, { code: 'CSRF_EXPIRED' });
  });
  assert.deepEqual(await api('/api/transactions/example', 'PATCH', { category: 'Income' }), { ok: true });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.body, calls[2].options.body);
});
test('origin failures do not retry and repeated expired tokens stop', async () => {
  let calls = 0;
  const blocked = createApi(async () => { calls++; return response(403, { code: 'INVALID_ORIGIN', error: 'Wrong origin' }); });
  await assert.rejects(blocked('/api/test', 'POST'), /Wrong origin/);
  assert.equal(calls, 1);
  calls = 0;
  const expired = createApi(async path => { calls++; return path === '/api/status' ? response(200, { csrf: 'new' }) : response(403, { code: 'CSRF_EXPIRED', error: 'Expired' }); });
  await assert.rejects(expired('/api/test', 'POST'), /Expired/);
  assert.equal(calls, 3);
});
