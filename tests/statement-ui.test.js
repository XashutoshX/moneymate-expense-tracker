import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { setupStatements } from '../public/statements.js';

test('import interface reviews edits, excludes duplicates, preserves a failed save and resets on close', async () => {
  const dom = new JSDOM('<!doctype html><body><div><button id="add-transaction">Add</button></div><p id="message"></p></body>', { url: 'http://localhost:3000' });
  const previous = { document: globalThis.document, FileReader: globalThis.FileReader, Option: globalThis.Option };
  globalThis.document = dom.window.document; globalThis.FileReader = dom.window.FileReader; globalThis.Option = dom.window.Option;
  const $ = selector => document.querySelector(selector);
  const base = { rowIndex: 1, date: '2026-09-01', merchant: '<img src=x onerror=alert(1)>', amount: 12550, type: 'expense', category: 'Uncategorized', errors: [], raw: 'Synthetic source', duplicate: false, possibleDuplicate: false };
  const calls = []; let failSave = true, reloaded;
  const api = async (path, method, data) => {
    calls.push({ path, data });
    if (path.endsWith('/upload')) return { token: 'test-token', sheets: [{ name: 'Transactions', width: 3, rowCount: 4, headerRow: 0, mapping: { date: 0, merchant: 1, amount: 2, debit: -1, credit: -1, direction: -1 }, sample: [['Date', 'Description', 'Amount']] }] };
    if (path.endsWith('/preview')) return { skipped: 0, rows: [base, { ...base, rowIndex: 2, duplicate: true }, { ...base, rowIndex: 3, possibleDuplicate: true }, { ...base, rowIndex: 4, date: '', amount: 0, errors: ['Check the date and amount.'] }] };
    if (path.endsWith('/commit')) { if (failSave) throw new Error('Temporary failure'); return { imported: data.rows.length, skipped: 0 }; }
    return { ok: true };
  };
  try {
    setupStatements(api, async result => { reloaded = result; }, () => [{ name: 'Uncategorized' }]);
    $('#statement-editor').showModal = function () { this.setAttribute('open', ''); };
    $('#statement-editor').close = function () { this.removeAttribute('open'); this.dispatchEvent(new dom.window.Event('close')); };
    $('#upload-statement').click();
    assert.equal($('#statement-upload-form').hidden, false);
    const file = new dom.window.File(['Date,Description,Amount\n01/09/2026,Cafe,125.50'], 'bank.csv', { type: 'text/csv' });
    Object.defineProperty($('#statement-file'), 'files', { configurable: true, value: [file] });
    $('#statement-password').value = 'temporary';
    await $('#statement-upload-form').onsubmit({ preventDefault() {} });
    assert.equal($('#statement-password').value, '');
    assert.equal($('#statement-map-form').hidden, false);
    await $('#statement-map-form').onsubmit({ preventDefault() {} });
    assert.equal($('#statement-save').textContent, 'Import 1 selected');
    assert.equal($('#statement-rows input[aria-label="Import row 3"]').disabled, true);
    assert.equal($('#statement-rows input[aria-label="Import row 4"]').checked, false);
    assert.equal($('#statement-rows img'), null, 'Statement content must never become markup');
    const description = $('#statement-rows input[aria-label="merchant for row 2"]');
    description.value = 'Corrected cafe'; description.dispatchEvent(new dom.window.Event('input'));
    $('#statement-rows input[aria-label="Import row 5"]').click();
    assert.equal($('#statement-save').disabled, true, 'Invalid selected rows block saving');
    $('#statement-rows input[aria-label="Import row 5"]').click();
    assert.equal($('#statement-save').disabled, false);
    assert.equal($('#statement-review-form').noValidate, true, 'Unchecked invalid inputs must not block selected valid rows');
    await $('#statement-review-form').onsubmit({ preventDefault() {} });
    assert.equal($('#statement-error').textContent, 'Temporary failure');
    assert.equal($('#statement-rows input[aria-label="merchant for row 2"]').value, 'Corrected cafe');
    failSave = false;
    await $('#statement-review-form').onsubmit({ preventDefault() {} });
    const save = calls.filter(call => call.path.endsWith('/commit')).at(-1).data;
    assert.deepEqual(save.rows.map(row => [row.rowIndex, row.merchant, row.amount]), [[1, 'Corrected cafe', 12550]]);
    assert.deepEqual(reloaded, { imported: 1, skipped: 0 });
    assert.equal($('#statement-editor').open, false);
    assert.ok(calls.some(call => call.path.endsWith('/discard')));
    $('#upload-statement').click();
    assert.equal($('#statement-upload-form').hidden, false);
  } finally {
    globalThis.document = previous.document; globalThis.FileReader = previous.FileReader; globalThis.Option = previous.Option; dom.window.close();
  }
});
