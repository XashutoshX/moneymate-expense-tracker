import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate, balances, myExpense } from '../public/splits.js';

test('equal shares preserve every paise and allocate remainders deterministically', () => {
  const shares = allocate(100, [{ id: 'me' }, { id: 'a' }, { id: 'b' }], 'equal');
  assert.deepEqual(shares.map(s => s.amount), [34, 33, 33]);
});
test('exact amounts and weighted shares support excluding the payer', () => {
  assert.deepEqual(allocate(10000, [{ id: 'a', exact: '25.50' }, { id: 'b', exact: '74.50' }], 'exact').map(p => p.amount), [2550, 7450]);
  assert.deepEqual(allocate(10000, [{ id: 'a', units: 1 }, { id: 'b', units: 3 }], 'shares').map(p => p.amount), [2500, 7500]);
  assert.equal(allocate(10000, [{ id: 'a' }], 'equal')[0].amount, 10000);
  assert.throws(() => allocate(10000, [{ id: 'a', exact: 99 }], 'exact'), /total/);
  assert.throws(() => allocate(10000, [{ id: 'a', units: 0 }], 'shares'), /positive/);
  const bill = { type: 'expense', review: 0, split: { paidBy: 'me', shares: allocate(10000, [{ id: 'a' }], 'equal') } };
  assert.equal(balances([bill], [{ id: 'a' }]).get('a'), 10000);
  assert.equal(myExpense(bill), 0);
});
test('percentage shares preserve paise and invalid totals fail', () => {
  assert.deepEqual(allocate(75700, [{ id: 'me', percent: 25 }, { id: 'a', percent: 75 }], 'percentage').map(s => s.amount), [18925, 56775]);
  assert.throws(() => allocate(100, [{ id: 'me', percent: 10 }, { id: 'a', percent: 10 }], 'percentage'), /100%/);
  assert.throws(() => allocate(100, [{ id: 'me' }, { id: 'me' }], 'equal'));
});
test('balances net what a person owes and what I owe; pending transactions are excluded', () => {
  const shares = allocate(10000, [{ id: 'me' }, { id: 'a' }], 'equal');
  const bill = { type: 'expense', review: 0, amount: 10000, split: { paidBy: 'me', shares } };
  assert.equal(balances([bill], [{ id: 'a' }]).get('a'), 5000);
  assert.equal(balances([{ ...bill, split: { paidBy: 'a', shares } }], [{ id: 'a' }]).get('a'), -5000);
  assert.equal(balances([bill, { ...bill, split: { paidBy: 'a', shares } }], [{ id: 'a' }]).get('a'), 0);
  assert.equal(balances([{ ...bill, review: 1 }], [{ id: 'a' }]).get('a'), 0);
  assert.equal(myExpense(bill), 5000);
});
