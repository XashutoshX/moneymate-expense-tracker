import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeoplePdf, peopleReport } from '../src/people-pdf.js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const people = [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }, { id: 'c', name: 'Casey' }];
const transaction = (id, paidBy, shares) => ({ id, date: '2026-09-15', merchant: 'Lunch', amount: 30000, type: 'expense', review: false, split: { paidBy, shares } });
const rows = [
  transaction('1', 'me', [{ id: 'me', amount: 10000 }, { id: 'a', amount: 10000 }, { id: 'b', amount: 10000 }]),
  transaction('2', 'a', [{ id: 'me', amount: 15000 }, { id: 'b', amount: 15000 }]),
  { ...transaction('pending', 'me', [{ id: 'a', amount: 30000 }]), review: true },
  { ...transaction('ignored', 'me', [{ id: 'a', amount: 30000 }]), type: 'ignored' }
];

test('report matches net balances and includes payers outside the split participants', () => {
  const report = peopleReport(rows, people);
  assert.deepEqual(report.map(p => p.balance), [-5000, 10000, 0]);
  assert.equal(report[0].transactions.length, 2);
  assert.equal(report[0].transactions[1].share, 0);
  assert.equal(report[1].transactions[1].balance, 0);
  assert.equal(report[2].transactions.length, 0);
});

test('PDF contains balances, details, continued pages and an empty state', async () => {
  const many = [...rows, ...Array.from({ length: 18 }, (_, i) => ({ ...rows[0], id: `long-${i}`, merchant: 'Long merchant description '.repeat(4) }))];
  const buffer = await createPeoplePdf(many, people, 'Test owner');
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) text += (await (await doc.getPage(i)).getTextContent()).items.map(item => item.str).join(' ') + '\n';
  assert.ok(doc.numPages > 4);
  assert.match(text, /Alice/); assert.match(text, /Bob/); assert.match(text, /Casey/);
  assert.match(text, /Their share: INR 0.00/);
  assert.match(text, /Paid by: Alice/);
  assert.match(text, /continued/);
  assert.match(text, /No confirmed split transactions/);
  assert.match(text, new RegExp(`Page ${doc.numPages} of ${doc.numPages}`));
  await doc.cleanup();
  const empty = await getDocument({ data: new Uint8Array(await createPeoplePdf([], [])) }).promise;
  const emptyText = (await (await empty.getPage(1)).getTextContent()).items.map(item => item.str).join(' ');
  assert.match(emptyText, /No people added yet/);
  await empty.cleanup();
});

