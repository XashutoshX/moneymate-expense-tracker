// Shared normalization for bank exports. Amounts are integer paise; balances
// are never used as transaction amounts and ambiguous directions need a choice.
export const MAX_ROWS = 5000;
export const fields = ['date', 'merchant', 'debit', 'credit', 'amount', 'direction'];
const aliases = {
  date: /^(transactiondate|txndate|trandate|transdate|date|postingdate|posteddate|valuedate)$/,
  merchant: /^(description|transactiondescription|narration|particulars|merchant|details|transactiondetails|remarks)$/,
  debit: /^(debit|debitamount|withdrawal|withdrawals|withdrawalamount|withdrawalsamount|paidout|dr|dramount)$/,
  credit: /^(credit|creditamount|deposit|deposits|depositamount|depositsamount|paidin|cr|cramount)$/,
  amount: /^(amount|transactionamount|txnamount|tranamount|amountinr)$/,
  direction: /^(type|transactiontype|drcr|crdr|debitcredit|creditdebit|dc)$/,
};
export function headerName(value) {
  return String(value ?? '').toLowerCase().replace(/\b(inr|rs|rupees)\b/g, '').replace(/\bamt\b/g, 'amount').replace(/[^a-z]/g, '');
}
export function detectMapping(row) {
  const result = Object.fromEntries(fields.map(field => [field, -1]));
  row.forEach((value, index) => {
    for (const field of fields) if (result[field] === -1 && aliases[field].test(headerName(value))) result[field] = index;
  });
  return result;
}
export function detectHeader(rows) {
  let headerRow = 0, best = 0;
  for (let index = 0; index < Math.min(rows.length, 100); index++) {
    const mapping = detectMapping(rows[index]);
    const score = Object.values(mapping).filter(value => value >= 0).length;
    if (mapping.date >= 0 && score > best) { best = score; headerRow = index; }
  }
  return { headerRow, mapping: detectMapping(rows[headerRow] || []) };
}
export function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  let delimiter;
  const directive = text.match(/^sep=([,;\t|])\r?\n/i);
  if (directive) { delimiter = directive[1]; text = text.slice(directive[0].length); }
  function read(separator) {
    const rows = []; let row = [], cell = '', quoted = false, afterQuote = false;
    function pushCell() { row.push(cell); cell = ''; afterQuote = false; if (row.length > 50) throw new Error('Statements can have up to 50 columns.'); }
    function pushRow() { pushCell(); rows.push(row); row = []; if (rows.length > MAX_ROWS + 100) throw new Error('Import up to 5,000 transactions at a time.'); }
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (char === '"') { if (text[index + 1] === '"') { cell += '"'; index++; } else { quoted = false; afterQuote = true; } }
        else cell += char;
      } else if (char === '"' && !cell && !afterQuote) quoted = true;
      else if (char === separator) pushCell();
      else if (char === '\r' || char === '\n') { if (char === '\r' && text[index + 1] === '\n') index++; pushRow(); }
      else if (afterQuote && char.trim()) throw new Error('Malformed CSV: unexpected text after a quoted field.');
      else cell += char;
      if (cell.length > 2000) throw new Error('A statement cell exceeds 2,000 characters.');
    }
    if (quoted) throw new Error('Malformed CSV: a quoted field is not closed.');
    if (cell || row.length || afterQuote) pushRow();
    return rows;
  }
  if (delimiter) return read(delimiter);
  let chosen, score = -1, lastError;
  for (const separator of [',', ';', '\t', '|']) {
    try {
      const rows = read(separator), detected = detectHeader(rows);
      const recognized = Object.values(detected.mapping).filter(index => index >= 0).length;
      const width = Math.max(0, ...rows.slice(0, 100).map(row => row.length));
      const value = recognized * 100 + width;
      if (value > score) { chosen = rows; score = value; }
    } catch (error) { lastError = error; }
  }
  if (!chosen || Math.max(0, ...chosen.map(row => row.length)) < 2) throw lastError || new Error('No CSV columns found. Use comma, semicolon, tab or pipe separators.');
  return chosen;
}
export function parseDate(value, order = 'DMY') {
  const raw = String(value ?? '').trim();
  let year, month, day, match;
  if ((match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/))) [, year, month, day] = match;
  else if ((match = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s+\d{2}:\d{2}(?::\d{2})?)?$/))) {
    [, day, month, year] = match;
    if (order === 'MDY') [day, month] = [month, day];
  } else if ((match = raw.match(/^(\d{1,2})[-\s/]([a-z]{3,9})[-\s/,]+(\d{2}|\d{4})$/i))) {
    [, day, month, year] = match;
    month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(month.slice(0, 3).toLowerCase()) + 1;
  } else return '';
  year = Number(year); if (year < 100) year += year >= 70 ? 1900 : 2000;
  const date = `${year}-${String(Number(month)).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date ? date : '';
}
export function parseAmount(value) {
  let raw = String(value ?? '').trim();
  if (!raw || /^[-–—]$/.test(raw)) return { amount: 0, sign: 1, direction: '' };
  const marker = raw.match(/\b(dr|cr)\.?$/i)?.[1]?.toLowerCase();
  raw = raw.replace(/\b(dr|cr)\.?$/i, '').trim().replace(/^(?:INR|Rs\.?)\s*/i, '').replace(/^₹\s*/, '');
  const negative = /^-/.test(raw) || /^\(.*\)$/.test(raw);
  raw = raw.replace(/^\((.*)\)$/, '$1').replace(/^[+-]/, '').trim();
  // Accept western and Indian thousands grouping, but never silently strip a
  // decimal comma or a foreign-currency symbol.
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d{1,2})?$/.test(raw)) throw new Error('Use an INR amount with a dot for decimals.');
  const [whole, fraction = ''] = raw.replaceAll(',', '').split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount)) throw new Error('Amount is too large.');
  return { amount, sign: negative ? -1 : 1, direction: marker === 'dr' ? 'expense' : marker === 'cr' ? 'income' : '' };
}
function direction(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (/^(dr|d|debit|withdrawal|expense|purchase)$/.test(raw)) return 'expense';
  if (/^(cr|c|credit|deposit|income)$/.test(raw)) return 'income';
  if (['refund', 'transfer', 'repayment'].includes(raw)) return raw;
  return '';
}
export function normalizeRows(rows, options) {
  const { headerRow, mapping, dateOrder = 'DMY', amountMode = 'explicit' } = options;
  if (!Number.isInteger(headerRow) || headerRow < -1 || headerRow >= rows.length) throw new Error('Choose a valid header row.');
  if (!['DMY', 'MDY'].includes(dateOrder) || !['explicit', 'signed', 'expense', 'income'].includes(amountMode)) throw new Error('Choose valid date and amount settings.');
  const width = Math.max(...rows.map(row => row.length));
  if (!mapping || fields.some(key => !Number.isInteger(mapping[key]) || mapping[key] < -1 || mapping[key] >= width)) throw new Error('Choose valid statement columns.');
  const used = fields.map(key => mapping[key]).filter(index => index >= 0);
  if (new Set(used).size !== used.length) throw new Error('Each column can only be mapped once.');
  if (mapping.date < 0 || mapping.merchant < 0 || (mapping.debit < 0 && mapping.credit < 0 && mapping.amount < 0)) throw new Error('Map the date, description and amount (or debit / credit) columns.');
  if (mapping.amount >= 0 && (mapping.debit >= 0 || mapping.credit >= 0)) throw new Error('Map either Amount or Debit / Credit, not both.');
  const result = []; let skipped = 0;
  for (let index = headerRow + 1; index < rows.length; index++) {
    const row = rows[index];
    if (row.every(value => !String(value).trim())) { skipped++; continue; }
    if (detectMapping(row).date >= 0 && detectMapping(row).merchant >= 0) { skipped++; continue; }
    const cell = key => mapping[key] >= 0 ? String(row[mapping[key]] ?? '').trim() : '';
    const merchant = cell('merchant');
    if (/^(?:opening|closing|brought forward|carried forward)\s*(?:balance)?$/i.test(merchant) || /^(?:grand\s+)?total(?:s)?$/i.test(merchant)) { skipped++; continue; }
    const errors = [], date = parseDate(cell('date'), dateOrder);
    if (!date) errors.push('Check the date.');
    if (!merchant || merchant.length > 100) errors.push('Description must be 1–100 characters.');
    let amount = 0, type = '';
    try {
      if (mapping.amount >= 0) {
        const parsed = parseAmount(cell('amount')), indicated = direction(cell('direction'));
        amount = parsed.amount;
        if (cell('direction') && !indicated) throw new Error('Unrecognized debit / credit type.');
        if (parsed.direction && indicated && parsed.direction !== indicated) throw new Error('Amount and type disagree.');
        type = indicated || parsed.direction || (amountMode === 'signed' ? (parsed.sign < 0 ? 'expense' : 'income') : ['expense', 'income'].includes(amountMode) ? amountMode : '');
        if (!type) errors.push('Choose a type or an amount convention.');
      } else {
        const debit = parseAmount(cell('debit')), credit = parseAmount(cell('credit'));
        if (debit.amount && credit.amount) throw new Error('Both debit and credit contain amounts.');
        if (debit.sign < 0 || credit.sign < 0 || debit.direction === 'income' || credit.direction === 'expense') throw new Error('Check the debit / credit signs.');
        amount = debit.amount || credit.amount; type = debit.amount ? 'expense' : 'income';
      }
      if (!amount) errors.push('Enter a positive transaction amount.');
    } catch (error) { errors.push(error.message); }
    result.push({ rowIndex: index, date, merchant, amount, type, category: 'Uncategorized', errors, raw: row.join(' | ') });
    if (result.length > MAX_ROWS) throw new Error('Import up to 5,000 transactions at a time.');
  }
  if (!result.length) throw new Error('No transaction rows found after the selected header.');
  return { rows: result, skipped };
}
