import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/categories.js';
import { parseHdfc } from '../src/parser.js';

const alert = 'Rs.22.00 is debited from your account ending 6995 towards VPA shop@bank (SRI DEVI BAKERS) on 09-09-26.';
test('recognized UPI bakery expense is categorized and auto-confirmed', () => {
  const result = classify(parseHdfc(alert, Date.now()));
  assert.equal(result.category, 'Food & dining');
  assert.equal(result.review, 0);
});
test('uncertain amount/date, unknown merchants and disabled auto-review need review', () => {
  for (const text of [alert + ' Balance Rs.1000.', alert.replace('09-09-26', 'unknown'), alert.replace('SRI DEVI BAKERS', 'SOME PERSON')]) {
    assert.equal(classify(parseHdfc(text, Date.now())).review, 1);
  }
  assert.equal(classify(parseHdfc(alert, Date.now()), false).review, 1);
});
test('Blink commerce is groceries, and credits are never auto-confirmed as expenses', () => {
  assert.equal(classify({ merchant: 'RSP*BLINK COMMERCE PVT', type: 'expense', amount: 75700, autoEligible: true }).category, 'Groceries');
  assert.equal(classify({ merchant: 'Blinkit', type: 'income', amount: 100, autoEligible: true }).review, 1);
  assert.equal(classify({ merchant: 'Blinkit', type: 'income', amount: 100 }).category, 'Income');
});
