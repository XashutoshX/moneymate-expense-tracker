import { parentPort, workerData } from 'node:worker_threads';
import { detectHeader, detectMapping, MAX_ROWS, parseAmount, parseCsv, parseDate } from './statement-parser.js';

function bounded(rows) {
  if (rows.length > MAX_ROWS + 100) throw new Error('Import up to 5,000 transactions at a time.');
  return rows.map(row => {
    if (row.length > 50) throw new Error('Statements can have up to 50 columns.');
    return row.map(value => {
      const text = value == null ? '' : String(value);
      if (text.length > 2000) throw new Error('A statement cell exceeds 2,000 characters.');
      return text;
    });
  });
}

// Use positions, not reading order, so an empty debit / credit cell stays empty.
export function pdfLines(items) {
  const lines = [];
  for (const item of items.filter(item => item.str?.trim()).sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])) {
    let line = lines.find(line => Math.abs(line.y - item.transform[5]) < 3);
    if (!line) { line = { y: item.transform[5], items: [] }; lines.push(line); }
    line.items.push({ text: item.str, x: item.transform[4], end: item.transform[4] + item.width });
  }
  return lines.sort((a, b) => b.y - a.y).map(line => {
    const cells = [];
    for (const item of line.items.sort((a, b) => a.x - b.x)) {
      const previous = cells.at(-1);
      if (previous && item.x - previous.end < 12) { previous.text += ' ' + item.text; previous.end = Math.max(previous.end, item.end); }
      else cells.push({ ...item });
    }
    return { ...line, cells };
  });
}
// SBI account summaries can draw their table headings as graphics. Only use
// this known layout when the bank identity and statement summary both match;
// reconcile counts and amounts before offering any rows for review.
function sbiTable(pages) {
  const lines = pages.flat();
  if (!lines.some(line => line.cells.some(cell => cell.text === 'State Bank of India'))) return null;
  const summary = lines.findIndex(line => line.cells.some(cell => /^Statement Summary\s*:/i.test(cell.text)));
  if (summary < 0) return null;
  const first = lines.find(line => line.cells.length === 7 && parseDate(line.cells[0].text) && parseDate(line.cells[1].text));
  if (!first) return null;
  const anchors = first.cells;
  const columnFor = item => anchors.findIndex((anchor, index) => index === anchors.length - 1 || (item.x + item.end) / 2 < (anchor.end + anchors[index + 1].x) / 2);
  const rows = [['Value Date', 'Post Date', 'Details', 'Ref No / Cheque No', 'Debit', 'Credit', 'Balance']];
  for (const page of pages) {
    let previous, pending = '';
    for (let index = 0; index < page.length; index++) {
      const line = page[index];
      if (line.cells.some(cell => /^Statement Summary\s*:/i.test(cell.text))) break;
      const row = Array(7).fill('');
      for (const item of line.items) {
        const column = columnFor(item);
        row[column] = [row[column], item.text].filter(Boolean).join(' ');
      }
      if (parseDate(row[0]) && parseDate(row[1])) {
        row[2] = [pending, row[2]].filter(Boolean).join(' ');
        rows.push(row); previous = row; pending = '';
      } else if (row[2] && row.every((cell, column) => column === 2 || !cell)) {
        // A short line immediately above the dates starts the next narrative.
        const next = page[index + 1];
        if (next && line.y - next.y < 9 && parseDate(next.cells[0]?.text)) pending = row[2];
        else if (previous) previous[2] += ' ' + row[2];
      } else { previous = undefined; pending = ''; }
    }
  }
  const totals = lines.slice(summary + 1).find(line => line.cells.length === 6 && /^\d+$/.test(line.cells[1].text) && /^\d+$/.test(line.cells[2].text));
  const fail = () => { throw new Error('The SBI table could not be matched to its statement totals. Export CSV or Excel from your bank and try again.'); };
  if (!totals) fail();
  try {
    let debits = 0, credits = 0, debitCount = 0, creditCount = 0;
    for (const row of rows.slice(1)) {
      const debit = parseAmount(row[4]).amount, credit = parseAmount(row[5]).amount;
      if ((!debit && !credit) || (debit && credit)) fail();
      debits += debit; credits += credit;
      debitCount += Boolean(debit); creditCount += Boolean(credit);
    }
    if (debitCount !== Number(totals.cells[1].text) || creditCount !== Number(totals.cells[2].text) || debits !== parseAmount(totals.cells[3].text).amount || credits !== parseAmount(totals.cells[4].text).amount) fail();
  } catch { fail(); }
  return rows;
}

export function pdfTable(pages) {
  const rows = []; let anchors, description = -1;
  for (const lines of pages) {
    let previous;
    for (const line of lines) {
      const cells = line.cells;
      const mapping = detectMapping(cells.map(cell => cell.text));
      if (mapping.date >= 0 && mapping.merchant >= 0 && (mapping.amount >= 0 || mapping.debit >= 0 || mapping.credit >= 0)) {
        anchors = cells; description = mapping.merchant;
        rows.push(cells.map(cell => cell.text)); previous = undefined; continue;
      }
      if (!anchors) continue;
      const row = Array(anchors.length).fill('');
      for (const item of line.items) {
        const center = (item.x + item.end) / 2;
        let column = anchors.findIndex((anchor, index) => index === anchors.length - 1 || center < (anchor.end + anchors[index + 1].x) / 2);
        row[column] = [row[column], item.text].filter(Boolean).join(' ');
      }
      const mapped = detectMapping(anchors.map(cell => cell.text));
      if (/^\d{1,4}[-/.\s]\w/.test(row[mapped.date])) {
        rows.push(row); previous = row;
      } else if (previous && row[description] && row.every((cell, index) => index === description || !cell)) {
        previous[description] += ' ' + row[description];
      } else if (row[mapped.date] && !/^(page|statement|total|opening|closing|continued|\*)/i.test(row[mapped.date])) {
        // Surface an unrecognized date-shaped record rather than guessing it.
        if (/\d/.test(row[mapped.date]) && [mapped.amount, mapped.debit, mapped.credit].some(index => index >= 0 && /\d/.test(row[index]))) rows.push(row);
        previous = undefined;
      } else previous = undefined;
    }
  }
  if (!rows.length) {
    const sbi = sbiTable(pages);
    if (sbi) return sbi;
    throw new Error('This PDF has readable text, but its transaction table layout was not recognized. Export CSV or Excel from your bank, or add transactions manually.');
  }
  return rows;
}

export async function extractStatement({ name, data, password = '' }) {
  const buffer = Buffer.from(data), extension = name.split('.').pop().toLowerCase();
  if (extension === 'csv') {
    const encoding = buffer[0] === 255 && buffer[1] === 254 ? 'utf-16le' : buffer[0] === 254 && buffer[1] === 255 ? 'utf-16be' : 'utf-8';
    let text;
    try { text = new TextDecoder(encoding, { fatal: true }).decode(buffer); }
    catch { throw new Error('Save the CSV as UTF-8 or UTF-16, then upload it again.'); }
    if (text.includes('\0')) throw new Error('This file is not a readable CSV.');
    return [{ name: 'CSV', rows: bounded(parseCsv(text)) }];
  }
  if (extension === 'xls' || extension === 'xlsx') {
    const ole = buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
    if (!ole && buffer.subarray(0, 2).toString() !== 'PK') throw new Error('This is not a valid Excel workbook. Export as .xls, .xlsx or CSV.');
    const XLSX = await import('xlsx');
    let book;
    try { book = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellNF: true, sheetRows: MAX_ROWS + 102, password }); }
    catch { throw new Error('Could not read this workbook. Save an unencrypted .xlsx or CSV copy and try again.'); }
    if (book.SheetNames.length > 20) throw new Error('Import a workbook with up to 20 sheets.');
    let total = 0;
    const sheets = book.SheetNames.map(name => {
      const sheet = book.Sheets[name];
      const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref'] || 'A1');
      if (range.e.r >= MAX_ROWS + 100 || range.e.c >= 50) throw new Error('Use a sheet with up to 5,000 transactions and 50 columns.');
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: true });
      // Convert only cells with an Excel date format, respecting the 1904 epoch.
      for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r: r + range.s.r, c: c + range.s.c })];
        if (cell?.t === 'n' && XLSX.SSF.is_date(cell.z || '')) {
          const date = XLSX.SSF.parse_date_code(cell.v, { date1904: Boolean(book.Workbook?.WBProps?.date1904) });
          if (date) rows[r][c] = `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
        }
      }
      total += rows.length;
      if (total > MAX_ROWS + 100) throw new Error('Import up to 5,000 transactions across the workbook at a time.');
      return { name, rows: bounded(rows) };
    }).filter(sheet => sheet.rows.some(row => row.some(Boolean)));
    if (!sheets.length) throw new Error('The workbook has no data.');
    return sheets;
  }
  if (extension === 'pdf') {
    if (buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('This is not a valid PDF file.');
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: new Uint8Array(buffer), password, isEvalSupported: false, useSystemFonts: true, disableFontFace: true, verbosity: 0 });
    try {
      const document = await task.promise;
      if (document.numPages > 100) throw new Error('Import a PDF with up to 100 pages at a time.');
      const pages = [];
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        if (!content.items.some(item => item.str?.trim())) throw new Error(`PDF page ${number} has no selectable text. Use an OCR copy or export CSV / Excel so transactions are not missed.`);
        pages.push(pdfLines(content.items)); page.cleanup();
      }
      return [{ name: 'PDF statement', rows: bounded(pdfTable(pages)) }];
    } catch (error) {
      if (error.name === 'PasswordException') throw new Error('This PDF needs a password, or the password is incorrect. Enter it and try again.');
      if (error.name === 'InvalidPDFException') throw new Error('Could not read this PDF. Download it again from your bank.');
      throw error;
    } finally { await task.destroy(); }
  }
  throw new Error('Choose a PDF, CSV, XLS or XLSX statement.');
}

if (parentPort) {
  try {
    const sheets = await extractStatement(workerData);
    parentPort.postMessage({ sheets: sheets.map(sheet => ({ ...sheet, ...detectHeader(sheet.rows) })) });
  } catch (error) { parentPort.postMessage({ error: error.message }); }
}
