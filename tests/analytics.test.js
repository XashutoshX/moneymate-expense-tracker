import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { averageDailySpend, renderAnalytics } from '../public/analytics.js';

test('analytics dashboard prioritizes behavior and removes unwanted views', () => {
  const dom = new JSDOM('<!doctype html><body><main id="app"></main></body>', { url: 'http://localhost:3000' });
  const previous = { document: globalThis.document, localStorage: globalThis.localStorage };
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  try {
    const transactions = [
      { id: 'food-1', date: '2026-09-02', merchant: 'Cafe', amount: 1200, type: 'expense', category: 'Food', review: 0, bank: 'HDFC' },
      { id: 'food-2', date: '2026-09-05', merchant: 'Cafe', amount: 800, type: 'expense', category: 'Food', review: 0, bank: 'HDFC' },
      { id: 'rent', date: '2026-09-10', merchant: 'Rent', amount: 30000, type: 'expense', category: 'Bills', review: 0, bank: 'Cash' },
      { id: 'salary', date: '2026-09-11', merchant: 'Salary', amount: 100000, type: 'income', category: 'Income', review: 0, bank: 'Other' },
      { id: 'pending', date: '2026-09-12', merchant: 'Pending', amount: 9000, type: 'expense', category: 'Food', review: 1, bank: 'ICICI' }
    ];
    renderAnalytics(document.querySelector('#app'), transactions, '2026-09', transaction => transaction.amount);
    assert.equal(document.querySelectorAll('.analytics-kpis article').length, 4);
    assert.equal(document.querySelector('.analytics-card h3').textContent, 'Behavior patterns');
    assert.deepEqual([...document.querySelectorAll('.analytics-card h3')].map(el => el.textContent), [
      'Behavior patterns', 'Spending, income & savings', 'Average spend', 'Budget adherence', 'Anomalies & duplicate checks'
    ]);
    assert.doesNotMatch(document.querySelector('#app').textContent, /YTD|MoM growth|Growth & cash flow|Payment methods|Category share of wallet|Frequency & largest|Forecast & projections|current burn/);
    const before = document.querySelector('.analytics-kpis').textContent;
    document.querySelector('.budget-editor button').click();
    assert.equal(document.querySelector('.analytics-kpis').textContent, before);
    assert.match(document.querySelector('.budget-editor').textContent, /Save budgets/);
  } finally {
    globalThis.document = previous.document;
    globalThis.localStorage = previous.localStorage;
    dom.window.close();
  }
});

test('daily average uses elapsed days for this month and full calendar days for past months', () => {
  assert.equal(averageDailySpend(150000, '2026-09', '2026-09-15'), 10000);
  assert.equal(averageDailySpend(150000, '2026-09', '2026-09-01'), 150000);
  assert.equal(averageDailySpend(300000, '2026-09', '2026-10-01'), 10000);
  assert.equal(averageDailySpend(310000, '2026-08', '2026-09-15'), 10000);
  assert.equal(averageDailySpend(280000, '2026-02', '2026-09-15'), 10000);
  assert.equal(averageDailySpend(290000, '2024-02', '2026-09-15'), 10000);
  assert.equal(averageDailySpend(0, '2026-09', '2026-09-15'), 0);
});
