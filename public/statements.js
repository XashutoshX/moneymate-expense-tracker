const $ = selector => document.querySelector(selector);
const el = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
const money = amount => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(amount / 100);
const mappingFields = { date: 'Date', merchant: 'Description / merchant', debit: 'Debit / withdrawal', credit: 'Credit / deposit', amount: 'Single amount column', direction: 'Type / Dr–Cr' };
const types = ['expense', 'income', 'refund', 'transfer', 'repayment'];
function paise(value) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return 0;
  const [whole, decimal = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? amount : 0;
}
function valid(row) {
  return /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(Date.parse(row.date)) && new Date(row.date).toISOString().slice(0, 10) === row.date
    && row.merchant.trim().length > 0 && row.merchant.length <= 100 && Number.isSafeInteger(row.amount) && row.amount > 0 && types.includes(row.type);
}
export function setupStatements(api, reload, categories) {
  const open = el('button', 'Upload statement'); open.type = 'button'; open.id = 'upload-statement'; open.className = 'secondary';
  const actions = el('div'); actions.className = 'statement-actions';
  $('#add-transaction').before(actions); actions.append(open, $('#add-transaction'));
  const dialog = el('dialog'); dialog.id = 'statement-editor'; dialog.setAttribute('aria-labelledby', 'statement-title');
  // Static markup only. File contents are always rendered using textContent.
  dialog.innerHTML = `
    <h2 id="statement-title">Import a bank statement</h2>
    <p id="statement-step" class="statement-step">1. Upload · 2. Match columns · 3. Review</p>
    <form id="statement-upload-form">
      <p>Upload PDF, CSV or Excel (.xls / .xlsx), up to 10 MB. Files are processed on this computer.</p>
      <label class="statement-file">Bank statement<input id="statement-file" type="file" accept=".pdf,.csv,.xls,.xlsx" required></label>
      <div class="statement-grid"><label>Bank<select id="statement-bank"><option>HDFC</option><option>ICICI</option><option>Other</option></select></label>
      <label>Last 4 account / card digits (optional)<input id="statement-account" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off"></label></div>
      <label>PDF password (if required)<input id="statement-password" type="password" maxlength="256" autocomplete="off"></label>
      <p class="muted">Use an INR statement with selectable text. Scanned PDFs need OCR; export CSV or Excel from your bank for those. Passwords and original files are not saved.</p>
      <button id="statement-read" type="submit">Read statement</button>
    </form>
    <form id="statement-map-form" hidden>
      <p id="statement-filename"></p>
      <div class="statement-grid"><label>Worksheet<select id="statement-sheet"></select></label><label>Header row<select id="statement-header"></select></label>
      <label>Date format<select id="statement-date-order"><option value="DMY">Day / month / year</option><option value="MDY">Month / day / year</option></select></label>
      <label>Single amount convention<select id="statement-amount-mode"><option value="explicit">Use Dr / Cr or type column</option><option value="signed">Negative = expense, positive = income</option><option value="expense">All amounts are expenses</option><option value="income">All amounts are income</option></select></label></div>
      <p>Match the statement columns below. Use Debit / Credit or a single Amount column. Leave balance columns unmapped.</p>
      <div id="statement-mapping" class="statement-grid"></div>
      <details open><summary>Original rows (first 100)</summary><div class="table-wrap statement-sample"><table><thead id="statement-sample-head"></thead><tbody id="statement-sample"></tbody></table></div></details>
      <button id="statement-preview" type="submit">Preview transactions</button>
    </form>
    <form id="statement-review-form" novalidate hidden>
      <p>Check these entries against your statement. Selected rows will be saved as confirmed transactions and included in totals. You can edit every field below.</p>
      <p class="muted">Already imported rows are locked. Possible duplicates (same bank, date, amount and type) start unchecked; select them only if they are separate payments. Compare PDF row counts and totals with your statement.</p>
      <p id="statement-summary" role="status"></p>
      <div class="actions"><button id="statement-select" type="button" class="secondary">Select valid, nonduplicate rows</button><button id="statement-clear" type="button" class="secondary">Clear selection</button></div>
      <div class="table-wrap statement-preview-table"><table><thead><tr><th>Import</th><th>Date</th><th>Description</th><th>Amount (INR)</th><th>Type</th><th>Category</th><th>Check</th></tr></thead><tbody id="statement-rows"></tbody></table></div>
      <div class="statement-pagination"><button id="statement-prev" type="button" class="secondary">Previous</button><span id="statement-page"></span><button id="statement-next" type="button" class="secondary">Next</button></div>
      <div class="actions"><button id="statement-remap" type="button" class="secondary">Back to columns</button><button id="statement-save" type="submit">Import selected</button></div>
    </form>
    <p id="statement-error" role="alert"></p><p id="statement-progress" role="status" aria-live="polite"></p>
    <div class="actions"><button id="statement-close" type="button" class="secondary">Cancel</button></div>`;
  document.body.append(dialog);
  let upload, rows = [], page = 0, skipped = 0, busy = false, bank, account;
  function step(number) {
    for (const [index, name] of ['upload', 'map', 'review'].entries()) $(`#statement-${name}-form`).hidden = index + 1 !== number;
    $('#statement-step').textContent = `${number} of 3 · ${['Upload statement', 'Match columns', 'Review transactions'][number - 1]}`;
    $('#statement-error').textContent = ''; dialog.scrollTop = 0;
  }
  function pending(value, message = '') {
    busy = value; dialog.setAttribute('aria-busy', String(value));
    for (const field of dialog.querySelectorAll('button, input, select')) field.disabled = value;
    $('#statement-progress').textContent = message;
    if (!value && !$('#statement-review-form').hidden) renderRows();
  }
  async function discard() {
    if (upload) { const token = upload.token; upload = undefined; await api('/api/statements/discard', 'POST', { token }).catch(() => {}); }
  }
  open.onclick = () => {
    $('#statement-upload-form').reset(); $('#statement-progress').textContent = ''; rows = []; step(1); dialog.showModal();
  };
  $('#statement-close').onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { $('#statement-password').value = ''; $('#statement-file').value = ''; rows = []; void discard(); });
  $('#statement-upload-form').onsubmit = async event => {
    event.preventDefault();
    const file = $('#statement-file').files[0];
    if (!file || !file.size || file.size > 10 * 1024 * 1024) { $('#statement-error').textContent = 'Choose a nonempty statement up to 10 MB.'; return; }
    pending(true, 'Reading statement…'); $('#statement-error').textContent = '';
    try {
      bank = $('#statement-bank').value; account = $('#statement-account').value;
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(new Error('Could not open this file.')); reader.readAsDataURL(file);
      });
      let password = $('#statement-password').value;
      while (true) {
        try {
          upload = await api('/api/statements/upload', 'POST', { name: file.name, data, password });
          break;
        } catch (error) {
          if (!/needs a password|password is incorrect/i.test(error.message) || typeof globalThis.window?.prompt !== 'function') throw error;
          const entered = globalThis.window.prompt('This file is password protected. Enter its password:', password);
          if (entered === null) throw error;
          password = entered;
          $('#statement-password').value = entered;
        }
      }
      $('#statement-password').value = ''; $('#statement-file').value = '';
      $('#statement-filename').textContent = `${file.name} · ${bank}${account ? ` · ending ${account}` : ''}`;
      $('#statement-sheet').replaceChildren(...upload.sheets.map((sheet, index) => new Option(`${sheet.name} (${sheet.rowCount} rows)`, index)));
      $('#statement-date-order').value = 'DMY'; $('#statement-amount-mode').value = 'explicit';
      setupSheet(); step(2);
    } catch (error) { $('#statement-error').textContent = error.message; }
    finally { pending(false); }
  };
  function setupSheet() {
    const sheet = upload.sheets[Number($('#statement-sheet').value)];
    $('#statement-header').replaceChildren(new Option('No header (data starts at row 1)', -1), ...sheet.sample.map((row, index) => new Option(`Row ${index + 1}: ${row.join(' · ').slice(0, 100)}`, index)));
    $('#statement-header').value = sheet.headerRow;
    setupMapping(sheet.mapping);
    const head = el('tr'); head.append(el('th', 'Row'), ...Array.from({ length: sheet.width }, (_, index) => el('th', `Column ${index + 1}`)));
    $('#statement-sample-head').replaceChildren(head);
    $('#statement-sample').replaceChildren(...sheet.sample.map((row, index) => { const tr = el('tr'); tr.append(el('td', index + 1), ...Array.from({ length: sheet.width }, (_, column) => el('td', row[column] || ''))); return tr; }));
  }
  function setupMapping(mapping = {}) {
    const sheet = upload.sheets[Number($('#statement-sheet').value)], header = sheet.sample[Number($('#statement-header').value)] || [];
    $('#statement-mapping').replaceChildren(...Object.entries(mappingFields).map(([field, name]) => {
      const label = el('label', name), select = el('select'); select.name = field;
      select.append(new Option('Not used', -1), ...Array.from({ length: sheet.width }, (_, index) => new Option(`${index + 1}: ${header[index] || 'Column ' + (index + 1)}`, index)));
      select.value = mapping[field] ?? -1; label.append(select); return label;
    }));
  }
  $('#statement-sheet').onchange = setupSheet;
  $('#statement-header').onchange = () => setupMapping(Object.fromEntries([...$('#statement-mapping').querySelectorAll('select')].map(select => [select.name, Number(select.value)])));
  $('#statement-map-form').onsubmit = async event => {
    event.preventDefault(); pending(true, 'Preparing preview…'); $('#statement-error').textContent = '';
    try {
      const result = await api('/api/statements/preview', 'POST', { token: upload.token, sheetIndex: Number($('#statement-sheet').value), bank, account,
        headerRow: Number($('#statement-header').value), mapping: Object.fromEntries([...$('#statement-mapping').querySelectorAll('select')].map(select => [select.name, Number(select.value)])),
        dateOrder: $('#statement-date-order').value, amountMode: $('#statement-amount-mode').value });
      rows = result.rows.map(row => ({ ...row, selected: !row.duplicate && !row.possibleDuplicate && !row.errors.length }));
      skipped = result.skipped; page = 0; step(3);
    } catch (error) { $('#statement-error').textContent = error.message; }
    finally { pending(false); }
  };
  function summarize() {
    const selected = rows.filter(row => row.selected), invalid = selected.filter(row => !valid(row));
    const expenses = selected.filter(row => row.type === 'expense').reduce((sum, row) => sum + row.amount, 0);
    const income = selected.filter(row => ['income', 'refund'].includes(row.type)).reduce((sum, row) => sum + row.amount, 0);
    $('#statement-summary').textContent = `${rows.length} rows · ${selected.length} selected · ${rows.filter(row => row.duplicate).length} already imported · ${rows.filter(row => row.possibleDuplicate).length} possible duplicates · ${rows.filter(row => !valid(row)).length} need correction · ${skipped} headers / blank / balance rows skipped. Selected expenses: ${money(expenses)}. Received: ${money(income)}.`;
    $('#statement-save').disabled = busy || !selected.length || invalid.length > 0;
    $('#statement-save').textContent = `Import ${selected.length} selected`;
  }
  function renderRows() {
    const fragment = document.createDocumentFragment();
    for (const row of rows.slice(page * 50, page * 50 + 50)) {
      const tr = el('tr'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = row.selected; checkbox.disabled = row.duplicate;
      checkbox.setAttribute('aria-label', `Import row ${row.rowIndex + 1}`); checkbox.onchange = () => { row.selected = checkbox.checked; summarize(); };
      const first = el('td'); first.append(checkbox, el('small', `Row ${row.rowIndex + 1}`)); tr.append(first);
      const note = el('td'); note.className = 'statement-row-note';
      const updateNote = () => {
        note.replaceChildren(el('span', row.duplicate ? 'Already imported' : row.possibleDuplicate ? 'Possible duplicate' : valid(row) ? 'Ready' : 'Needs correction'));
        if (row.errors.length) note.append(el('small', `Parser: ${row.errors.join(' ')}`));
        const details = el('details'), summary = el('summary', 'Original row'); details.append(summary, el('small', row.raw)); note.append(details);
      };
      for (const field of ['date', 'merchant', 'amount', 'type', 'category']) {
        const td = el('td'), input = el(['type', 'category'].includes(field) ? 'select' : 'input');
        input.setAttribute('aria-label', `${field} for row ${row.rowIndex + 1}`); input.disabled = row.duplicate;
        if (field === 'date') input.type = 'date';
        if (field === 'merchant') input.maxLength = 100;
        if (field === 'amount') { input.type = 'number'; input.min = '0.01'; input.step = '0.01'; }
        if (field === 'type') input.append(new Option('Choose type', ''), ...types.map(type => new Option(type[0].toUpperCase() + type.slice(1), type)));
        if (field === 'category') input.append(...categories().map(category => new Option(category.name, category.name)));
        input.value = field === 'amount' ? row.amount ? (row.amount / 100).toFixed(2) : '' : row[field];
        input.oninput = () => { row[field] = field === 'amount' ? paise(input.value) : input.value; updateNote(); summarize(); };
        td.append(input); tr.append(td);
      }
      updateNote(); tr.append(note); fragment.append(tr);
    }
    $('#statement-rows').replaceChildren(fragment);
    $('#statement-page').textContent = `Page ${page + 1} of ${Math.max(1, Math.ceil(rows.length / 50))}`;
    $('#statement-prev').disabled = page === 0; $('#statement-next').disabled = (page + 1) * 50 >= rows.length;
    summarize();
  }
  $('#statement-prev').onclick = () => { page--; renderRows(); };
  $('#statement-next').onclick = () => { page++; renderRows(); };
  $('#statement-select').onclick = () => { rows.forEach(row => { row.selected = !row.duplicate && !row.possibleDuplicate && valid(row); }); renderRows(); };
  $('#statement-clear').onclick = () => { rows.forEach(row => { row.selected = false; }); renderRows(); };
  $('#statement-remap').onclick = () => step(2);
  $('#statement-review-form').onsubmit = async event => {
    event.preventDefault(); pending(true, 'Adding transactions…'); $('#statement-error').textContent = '';
    try {
      const result = await api('/api/statements/commit', 'POST', { token: upload.token, sheetIndex: Number($('#statement-sheet').value), bank, account,
        rows: rows.filter(row => row.selected).map(({ rowIndex, date, merchant, amount, type, category }) => ({ rowIndex, date, merchant, amount, type, category })) });
      dialog.close();
      await reload(result).catch(error => { $('#message').textContent = `Added ${result.imported} transactions. Refresh to update the table: ${error.message}`; });
    } catch (error) { $('#statement-error').textContent = error.message; }
    finally { pending(false); }
  };
}
