import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { deleteButton } from '../public/transaction-delete.js';

test('deleting a transaction removes its split and totals, and persists across statement reimports', () => {
  const directory = mkdtempSync(join(tmpdir(), 'expense-delete-'));
  const url = name => JSON.stringify(new URL('../src/' + name, import.meta.url).href);
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { db } from ${url('store.js')};
      import { deleteTransaction, listTransactions, featureRequest } from ${url('features.js')};
      import { addManualTransaction } from ${url('manual.js')};
      import { uploadStatement, previewStatement, commitStatement } from ${url('statements.js')};
      const input = { date: '2026-09-01', time: '', merchant: 'Cafe', amount: 10000, type: 'expense', category: 'Food & dining', bank: 'Cash' };
      const first = addManualTransaction(input), second = addManualTransaction(input);
      featureRequest('/api/splits/' + first.id, 'POST', { participants: [{ id: 'me' }], mode: 'equal', paidBy: 'me' });
      assert.deepEqual(deleteTransaction(first.id), { ok: true });
      assert.deepEqual(deleteTransaction(first.id), { ok: true });
      assert.equal(deleteTransaction('missing'), null);
      assert.equal(db.prepare('SELECT count(*) AS n FROM splits').get().n, 0);
      assert.deepEqual(listTransactions().map(t => t.id), [second.id]);
      assert.equal(db.prepare('SELECT sum(amount) AS total FROM transactions').get().total, 10000);
      const upload = await uploadStatement({ name: 'test.csv', data: Buffer.from('Date,Description,Debit,Credit\\n01/09/2026,Cafe,100,').toString('base64') });
      const options = { token: upload.token, bank: 'Other', account: '', sheetIndex: 0, headerRow: upload.sheets[0].headerRow, mapping: upload.sheets[0].mapping };
      const preview = previewStatement(options);
      assert.equal(commitStatement({ ...options, rows: preview.rows }).imported, 1);
      deleteTransaction(listTransactions().find(t => t.id.startsWith('statement-')).id);
      assert.equal(previewStatement(options).rows[0].duplicate, true);
      assert.deepEqual(commitStatement({ ...options, rows: preview.rows }), { imported: 0, skipped: 1 });
      db.close();
    `], { cwd: directory, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const restart = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'; import { db } from ${url('store.js')};
      assert.equal(db.prepare('SELECT count(*) AS n FROM transactions').get().n, 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM deleted_transactions').get().n, 2); db.close();
    `], { cwd: directory, encoding: 'utf8' });
    assert.equal(restart.status, 0, restart.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('delete button supports cancellation, retry after failure, and refresh after success', async () => {
  const dom = new JSDOM('<p id="message"></p>');
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document; globalThis.window = dom.window;
  try {
    let accepted = false, fail = true, calls = 0, refreshes = 0;
    window.confirm = text => { assert.match(text, /Cafe/); assert.match(text, /split will also be removed/); return accepted; };
    const message = document.querySelector('p');
    const button = deleteButton({ id: 'test/id', merchant: 'Cafe', date: '2026-09-01', amount: 10000, split: {} }, async (path, method) => {
      calls++; assert.equal(path, '/api/transactions/test%2Fid'); assert.equal(method, 'DELETE');
      if (fail) throw new Error('Try again');
    }, async () => { refreshes++; }, message);
    await button.onclick(); assert.equal(calls, 0);
    accepted = true; await button.onclick();
    assert.equal(message.textContent, 'Try again'); assert.equal(button.disabled, false); assert.equal(refreshes, 0);
    fail = false; await button.onclick();
    assert.equal(message.textContent, 'Transaction deleted.'); assert.equal(refreshes, 1);
  } finally { globalThis.document = previous.document; globalThis.window = previous.window; dom.window.close(); }
});
