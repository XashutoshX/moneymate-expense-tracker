import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as XLSX from 'xlsx';
import { parseCsv, parseDate, parseAmount, detectHeader, normalizeRows } from '../src/statement-parser.js';
import { extractStatement, pdfLines, pdfTable } from '../src/statement-extract.js';
import { csv, pdfFixture } from './statement-fixtures.js';

test('CSV respects quoted commas, multiline descriptions, separators and preambles', () => {
  for (const delimiter of [',', ';', '\t', '|']) {
    const text = `Bank export\nDate${delimiter}Description${delimiter}Debit${delimiter}Credit\n01/09/2026${delimiter}"Cafe, \"\"Central\"\"\nLunch"${delimiter}125.50${delimiter}\n`;
    const rows = parseCsv(text), result = normalizeRows(rows, detectHeader(rows));
    assert.equal(result.rows[0].date, '2026-09-01');
    assert.equal(result.rows[0].merchant, 'Cafe, "Central"\nLunch');
    assert.equal(result.rows[0].amount, 12550);
    assert.deepEqual(result.rows[0].errors, []);
  }
  assert.equal(parseCsv('\uFEFFsep=;\nDate;Description;Amount\n1/9/2026;Cafe;20')[0][1], 'Description');
  assert.throws(() => parseCsv('Date,Description\n1,"broken'), /quoted|columns/);
});

test('date and amount normalization is strict and supports Indian formats', () => {
  assert.equal(parseDate('31/02/2026'), '');
  assert.equal(parseDate('01/09/26'), '2026-09-01');
  assert.equal(parseDate('01/09/2026', 'MDY'), '2026-01-09');
  assert.equal(parseDate('9-Sep-2026'), '2026-09-09');
  assert.equal(parseAmount('1,23,456.78').amount, 12345678);
  assert.equal(parseAmount('Rs. -123.45').sign, -1);
  assert.equal(parseAmount('(123.45)').sign, -1);
  assert.equal(parseAmount('123.45 CR').direction, 'income');
  for (const value of ['12,50', 'USD 123.45', '123.456', '1e3', 'Infinity']) assert.throws(() => parseAmount(value));
});

test('balances cannot be inferred as amounts and ambiguous records require correction', () => {
  const rows = parseCsv(csv), detected = detectHeader(rows);
  assert.equal(detected.mapping.amount, -1);
  const result = normalizeRows(rows, detected);
  assert.deepEqual(result.rows.map(row => [row.amount, row.type]), [[12550, 'expense'], [5000000, 'income']]);
  const invalid = [['Date', 'Description', 'Debit', 'Credit'], ['31/02/2026', 'Cafe', '100', '200']];
  assert.equal(normalizeRows(invalid, detectHeader(invalid)).rows[0].errors.length, 2);
  const single = [['Date', 'Description', 'Amount'], ['01/09/26', 'Cafe', '100'], ['02/09/26', 'Bus', '-20']];
  assert.match(normalizeRows(single, detectHeader(single)).rows[0].errors.join(), /convention/);
  assert.deepEqual(normalizeRows(single, { ...detectHeader(single), amountMode: 'signed' }).rows.map(row => row.type), ['income', 'expense']);
  assert.throws(() => normalizeRows(rows, { ...detected, mapping: { ...detected.mapping, merchant: 0 } }), /once/);
});

test('PDF extraction keeps empty credit/debit columns, continuation lines, and repeated headers', async () => {
  const [sheet] = await extractStatement({ name: 'bank.pdf', data: pdfFixture({ pages: 2 }) });
  const result = normalizeRows(sheet.rows, detectHeader(sheet.rows));
  assert.equal(result.rows.length, 4);
  assert.deepEqual(result.rows.map(row => row.amount), [12550, 5000000, 12550, 5000000]);
  assert.equal(result.rows[0].merchant, 'Cafe Central');
  assert.ok(result.rows.every(row => row.errors.length === 0));
  await assert.rejects(extractStatement({ name: 'scan.pdf', data: pdfFixture({ empty: true }) }), /selectable text/);
  await assert.rejects(extractStatement({ name: 'bad.pdf', data: Buffer.from('not pdf') }), /valid PDF/);
});

test('SBI graphic headings use reconciled columns and keep narrative prefixes with the correct transaction', () => {
  const line = (y, cells) => cells.map(([x, str, width = 35]) => ({ str, width, transform: [1, 0, 0, 1, x, y] }));
  const pages = [pdfLines([
    ...line(780, [[340, 'State Bank of India']]),
    ...line(740, [[510, 'Balance']]),
    ...line(707, [[138, 'WDL TFR']]),
    ...line(700, [[27, '01/06/2026'], [82, '01/06/2026'], [138, 'UPI/DR/TEST', 120], [304, '-', 3], [357, '54.00', 20], [446, '-', 3], [510, '946.00']]),
    ...line(688, [[138, 'Cafe Central']]),
    ...line(657, [[138, 'DEP TFR']]),
    ...line(650, [[27, '02/06/2026'], [82, '02/06/2026'], [138, 'Refund', 120], [304, '-', 3], [366, '-', 3], [437, '20.00', 20], [510, '966.00']]),
  ]), pdfLines([
    ...line(740, [[510, 'Balance']]),
    ...line(704, [[138, 'DEBIT ACHDr TEST', 120]]),
    // The description starts above the dates, leaving this row's cell empty.
    ...line(700, [[27, '03/06/2026'], [82, '03/06/2026'], [304, '-', 3], [357, '10.00', 20], [446, '-', 3], [510, '956.00']]),
  ]), pdfLines([
    ...line(780, [[187, 'Statement Summary : 01-06-2026 To 30-06-2026']]),
    ...line(730, [[35, '1,000.00CR', 60], [142, '2', 10], [197, '1', 10], [258, '64.00'], [359, '20.00'], [479, '956.00CR', 65]]),
  ])];
  const rows = pdfTable(pages), result = normalizeRows(rows, detectHeader(rows));
  assert.deepEqual(result.rows.map(row => [row.amount, row.type, row.merchant]), [
    [5400, 'expense', 'WDL TFR UPI/DR/TEST Cafe Central'],
    [2000, 'income', 'DEP TFR Refund'],
    [1000, 'expense', 'DEBIT ACHDr TEST'],
  ]);
  assert.ok(result.rows.every(row => row.errors.length === 0));
  const mismatch = structuredClone(pages);
  mismatch[2][1].cells[1].text = '3';
  assert.throws(() => pdfTable(mismatch), /statement totals/);
  const wrongAmount = structuredClone(pages);
  wrongAmount[2][1].cells[3].text = '65.00';
  assert.throws(() => pdfTable(wrongAmount), /statement totals/);
  assert.throws(() => pdfTable(pages.slice(0, 2)), /layout was not recognized/);
  const otherBank = structuredClone(pages);
  otherBank[0][0].cells[0].text = 'Another bank';
  assert.throws(() => pdfTable(otherBank), /layout was not recognized/);
});

test('XLS and XLSX preserve Excel dates, worksheet selection, amounts and the 1904 epoch', async () => {
  for (const bookType of ['xls', 'xlsx']) for (const date1904 of [false, true]) {
    const book = XLSX.utils.book_new();
    book.Workbook = { WBProps: { date1904 } };
    const sheet = XLSX.utils.aoa_to_sheet([['Date', 'Description', 'Debit', 'Credit'], [date1904 ? 44804 : 46266, 'Cafe', 125.5, '']]);
    sheet.A2.z = 'dd/mm/yyyy';
    XLSX.utils.book_append_sheet(book, sheet, 'Transactions');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Information'], ['Synthetic fixture']]), 'Notes');
    const sheets = await extractStatement({ name: `statement.${bookType}`, data: XLSX.write(book, { type: 'buffer', bookType }) });
    assert.equal(sheets.length, 2);
    const result = normalizeRows(sheets[0].rows, detectHeader(sheets[0].rows));
    assert.equal(result.rows[0].date, '2026-09-01');
    assert.equal(result.rows[0].amount, 12550);
  }
});

test('statement imports are atomic, retry safe, persist and flag overlapping sources', () => {
  const directory = mkdtempSync(join(tmpdir(), 'statement-import-'));
  const moduleUrl = new URL('../src/statements.js', import.meta.url).href;
  const storeUrl = new URL('../src/store.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { uploadStatement, previewStatement, commitStatement, discardStatement } from ${JSON.stringify(moduleUrl)};
    import { db } from ${JSON.stringify(storeUrl)};
    const input = { name: 'bank.csv', data: Buffer.from(${JSON.stringify(csv)}).toString('base64') };
    const upload = await uploadStatement(input);
    const options = { token: upload.token, bank: 'HDFC', account: '1234', sheetIndex: 0, headerRow: upload.sheets[0].headerRow, mapping: upload.sheets[0].mapping };
    const preview = previewStatement(options);
    assert.equal(db.prepare('SELECT count(*) AS n FROM transactions').get().n, 0);
    assert.throws(() => commitStatement({ ...options, rows: [preview.rows[0], { ...preview.rows[1], amount: -1 }] }));
    assert.equal(db.prepare('SELECT count(*) AS n FROM transactions').get().n, 0);
    assert.deepEqual(commitStatement({ ...options, rows: preview.rows }), { imported: 2, skipped: 0 });
    assert.deepEqual(commitStatement({ ...options, rows: preview.rows }), { imported: 0, skipped: 2 });
    assert.ok(previewStatement(options).rows.every(row => row.duplicate));
    const renamed = await uploadStatement({ ...input, name: 'renamed.csv' });
    assert.ok(previewStatement({ ...options, token: renamed.token }).rows.every(row => row.duplicate));
    const overlap = await uploadStatement({ ...input, data: Buffer.from(${JSON.stringify(csv)} + '\\n').toString('base64') });
    assert.ok(previewStatement({ ...options, token: overlap.token }).rows.every(row => row.possibleDuplicate));
    assert.ok(previewStatement({ ...options, account: '9999', token: overlap.token }).rows.every(row => !row.possibleDuplicate));
    assert.equal(db.prepare('SELECT SUM(amount) AS total FROM transactions WHERE review=0 AND type=?').get('expense').total, 12550);
    assert.equal(db.prepare('SELECT source_file FROM transactions LIMIT 1').get().source_file, 'bank.csv');
    discardStatement(upload.token);
    assert.throws(() => previewStatement(options), /expired/);
    await assert.rejects(uploadStatement({ name: 'bad.exe', data: 'YQ==' }), /Choose/);
    db.close();
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: directory, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const restart = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { db } from ${JSON.stringify(storeUrl)};
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 2); db.close();
    `], { cwd: directory, encoding: 'utf8' });
    assert.equal(restart.status, 0, restart.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
