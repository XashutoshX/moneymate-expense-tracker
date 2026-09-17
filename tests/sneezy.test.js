import test from 'node:test';
import assert from 'node:assert/strict';
import { assess } from '../public/sneezy.js';
const expense = { date: '2026-09-10', merchant: 'Cafe', type: 'expense', amount: 10000, category: 'Food & dining', review: 0 };
test('Sneezy uses personal shares and excludes pending expenses and other months', () => {
  const result = assess([{ ...expense, split: { shares: [{ id: 'me', amount: 2500 }] } }, { ...expense, review: 1 }, { ...expense, date: '2026-08-01' }], '2026-09', 20);
  assert.equal(result.total, 2500);
  assert.equal(result.saving, 500);
  assert.equal(result.pending, 1);
  assert.ok(result.flags.some(f => f.title.includes('No income')));
});
test('Sneezy separates refunds and highlights possible duplicates without asserting fraud', () => {
  const result = assess([expense, expense, { ...expense, type: 'income', amount: 5000 }, { ...expense, type: 'refund', amount: 1000 }], '2026-09');
  assert.equal(result.income, 5000); assert.equal(result.refunds, 1000);
  assert.ok(result.flags.some(f => f.title.includes('possible duplicate')));
  assert.ok(result.flags.some(f => f.title.includes('exceed')));
});
test('empty data produces no invented savings or cutbacks', () => {
  const result = assess([], '2026-09');
  assert.equal(result.saving, 0); assert.equal(result.suggestions.length, 0);
});
