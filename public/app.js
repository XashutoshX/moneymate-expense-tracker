import { createApi } from './api.js';
import { setupFeatures } from './features.js';
import { setupStatements } from './statements.js';
import { deleteButton } from './transaction-delete.js';
const api = createApi();
const $ = selector => document.querySelector(selector);
const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(value / 100);
const summaryAmounts = new Map();
let summaryHidden = false;
try {
  const saved = localStorage.getItem('summary-hidden');
  summaryHidden = saved === null
    ? ['expense', 'income'].some(id => localStorage.getItem(`summary-hidden-${id}`) === 'true')
    : saved === 'true';
} catch {}
for (const id of ['expense', 'income']) {
  const amount = $(`#${id}`);
  const heading = amount.previousElementSibling;
  heading.classList.add('summary-heading');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'summary-visibility';
  button.setAttribute('aria-controls', 'expense income');
  const summary = { value: money(0), update() {
    amount.textContent = summaryHidden ? '••••••' : summary.value;
    if (summaryHidden) amount.setAttribute('aria-label', 'Amount hidden');
    else amount.removeAttribute('aria-label');
    const action = `${summaryHidden ? 'Show' : 'Hide'} confirmed expenses and money received amounts`;
    button.setAttribute('aria-label', action);
    button.title = action;
    button.replaceChildren(symbol(summaryHidden ? 'visibility_off' : 'visibility'));
  } };
  button.onclick = () => {
    summaryHidden = !summaryHidden;
    try { localStorage.setItem('summary-hidden', String(summaryHidden)); } catch {}
    for (const item of summaryAmounts.values()) item.update();
  };
  heading.append(button);
  summaryAmounts.set(id, summary);
  summary.update();
}
function setSummaryAmount(id, value) {
  const summary = summaryAmounts.get(id);
  summary.value = money(value);
  summary.update();
}
let transactions = [], categories = [], selected, heatmapMonths = [], heatmapIndex = 11, selectedHeatmapDate = '';
let selectedIcon = 'folder', reviewPosition;
const iconLabels = { wifi: 'Internet / Wi-Fi', smartphone: 'Mobile / phone', bolt: 'Electricity', water_drop: 'Water', local_fire_department: 'Gas', folder: 'General', shopping_cart: 'Groceries', restaurant: 'Food & dining', local_taxi: 'Transport', shopping_bag: 'Shopping', lightbulb: 'Utilities', medication: 'Health', movie: 'Entertainment', flight: 'Travel', school: 'Education', home: 'Home / rent', payments: 'Income', swap_horiz: 'Transfers', pets: 'Pets', redeem: 'Gifts', fitness_center: 'Fitness', work: 'Work', local_cafe: 'Coffee', savings: 'Savings', credit_card: 'Card', sports_esports: 'Gaming', directions_car: 'Car', build: 'Repairs' };
function symbol(name) {
  const span = document.createElement('span'); span.className = 'material-symbols-outlined';
  span.textContent = name; span.setAttribute('aria-hidden', 'true'); return span;
}
function previewCategory() {
  $('#category-preview').replaceChildren(symbol(categories.find(c => c.name === $('#category-select').value)?.icon || 'folder'));
}
async function loadCategories() {
  const result = await api('/api/categories'); categories = result.categories;
  $('#category-select').replaceChildren(...categories.map(c => new Option(c.name, c.name)));
  $('#category-icon').replaceChildren(...result.icons.map(icon => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-choice';
    button.dataset.icon = icon; button.setAttribute('aria-pressed', String(icon === selectedIcon));
    const label = document.createElement('span'); label.textContent = iconLabels[icon] || icon.replaceAll('_', ' ');
    button.append(symbol(icon), label);
    button.onclick = () => { selectedIcon = icon; for (const choice of $('#category-icon').children) choice.setAttribute('aria-pressed', String(choice.dataset.icon === icon)); };
    return button;
  }));
  previewCategory();
}
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
$('#date-from').value = today.slice(0, 7) + '-01';
$('#date-to').value = today;
async function load(rows) {
  if (rows) { transactions = rows; render(); return; }
  const status = await api('/api/status');
  if (!status.authenticated) {
    $('#connection').textContent = 'Sign in with Google to create your private expense workspace.';
    $('#setup').hidden = true;
    $('#connect').hidden = false;
    $('#connect').textContent = 'Sign in with Google';
    return;
  }
  $('#auto-review').checked = status.autoReview;
  $('#connection').textContent = status.connected ? `Connected to ${status.email}` : 'Upload a statement or add transactions below. Connect Gmail to sync bank alerts too.';
  $('#setup').hidden = status.configured;
  $('#connect').textContent = status.connected ? 'Reconnect Gmail' : 'Connect Gmail';
  $('#sync').disabled = !status.connected || status.syncing;
  $('#disconnect').hidden = !status.connected;
  $('#last-sync').textContent = status.lastSync ? `Last sync: ${new Date(Number(status.lastSync)).toLocaleString('en-IN')}` : 'No imports yet';
  $('#auto-review').disabled = !status.connected;
  await loadCategories();
  $('#ledger-panel').hidden = false;
  transactions = await api('/api/transactions'); render();
  await features.refresh(transactions);
}
function render() {
  const from = $('#date-from').value, to = $('#date-to').value, search = $('#search').value.toLowerCase();
  const invalid = from && to && from > to;
  $('#date-error').textContent = invalid ? 'The From date must be on or before the To date.' : '';
  const bank = $('#bank-filter').value;
  const monthly = transactions.filter(t => !invalid && (!bank || t.bank === bank) && (!from || t.date >= from) && (!to || t.date <= to));
  setSummaryAmount('expense', monthly.filter(t => !t.review && t.type === 'expense').reduce((sum, t) => sum + t.amount, 0));
  setSummaryAmount('income', monthly.filter(t => !t.review && ['income', 'refund'].includes(t.type)).reduce((sum, t) => sum + t.amount, 0));
  $('#review').textContent = monthly.filter(t => t.review).length;
  $('#clear-day-filter').hidden = !selectedHeatmapDate;
  renderHeatmap();
  const visible = monthly.filter(t => `${t.merchant} ${t.category} ${t.type}`.toLowerCase().includes(search));
  const fragment = document.createDocumentFragment();
  $('#empty').hidden = visible.length > 0;
  if (!visible.length && transactions.length) $('#empty').textContent = invalid ? 'Choose a valid date range.' : 'No transactions match this date range or search.';
  for (const t of visible) {
    const row = document.createElement('tr');
    const icon = categories.find(c => c.name === t.category)?.icon || 'folder';
    for (const value of [t.date, t.merchant, `${t.category} / ${t.type}`, money(t.amount), t.review ? 'Needs review' : t.note.startsWith('Automatically confirmed') ? 'Auto-confirmed' : 'Confirmed']) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    row.children[2].prepend(symbol(icon));
    const statusLabel = row.children[4].textContent;
    const statusPill = document.createElement('span');
    statusPill.className = `status-pill${t.review ? ' pending' : t.note.startsWith('Automatically confirmed') ? ' automatic' : ''}`;
    statusPill.textContent = statusLabel;
    row.children[4].replaceChildren(statusPill);
    row.children[0].append(document.createElement('br'), document.createTextNode(t.time || 'Time not provided'));
    row.children[1].append(document.createElement('br'), document.createTextNode(`${t.bank || 'HDFC'}${t.id.startsWith('manual-') ? ' · Manual' : t.id.startsWith('statement-') ? ' · Statement' : ''}`));
    const cell = document.createElement('td'), button = document.createElement('button');
    button.className = 'secondary'; button.textContent = t.review ? 'Review' : 'Edit';
    button.dataset.transactionId = t.id;
    button.onclick = () => edit(t); cell.append(button);
    if (t.type === 'expense') {
      const split = document.createElement('button'); split.className = 'secondary split-button'; split.textContent = t.split ? 'Edit split' : 'Split';
      split.disabled = Boolean(t.review); split.title = t.review ? 'Confirm the expense before splitting' : 'Split this expense';
      split.onclick = () => features.openSplit(t); cell.append(split);
    }
    cell.append(deleteButton(t, api, load, $('#message')));
    row.append(cell); fragment.append(row);
  }
  // Replace rows atomically: an empty table would collapse the document and clamp scrolling.
  $('#rows').replaceChildren(fragment);
}
function renderHeatmap() {
  const currentMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date());
  const latest = transactions.reduce((value, transaction) => transaction.date > value ? transaction.date : value, currentMonth + '-01').slice(0, 7);
  heatmapMonths = Array.from({ length: 12 }, (_, offset) => {
    const date = new Date(`${latest}-01T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() - 11 + offset); return date.toISOString().slice(0, 7);
  });
  heatmapIndex = Math.min(Math.max(heatmapIndex, 0), heatmapMonths.length - 1);
  const month = heatmapMonths[heatmapIndex];
  const monthDate = new Date(`${month}-01T00:00:00Z`);
  const label = `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][monthDate.getUTCMonth()]} ${monthDate.getUTCFullYear()}`;
  $('#heatmap-month-label').textContent = label;
  $('#heatmap-prev').disabled = heatmapIndex === 0; $('#heatmap-next').disabled = heatmapIndex === heatmapMonths.length - 1;
  const daily = new Map();
  for (const transaction of transactions) if (!transaction.review && transaction.type === 'expense' && transaction.date.startsWith(month)) daily.set(transaction.date, (daily.get(transaction.date) || 0) + transaction.amount);
  const max = Math.max(1, ...daily.values());
  const first = new Date(`${month}-01T00:00:00Z`); first.setUTCDate(1 - first.getUTCDay());
  const cells = [];
  for (let index = 0; index < 42; index++) {
    const date = new Date(first); date.setUTCDate(first.getUTCDate() + index);
    const key = date.toISOString().slice(0, 10), amount = daily.get(key) || 0, inMonth = key.startsWith(month);
    const cell = document.createElement('button'); cell.type = 'button'; cell.className = `heat-cell level-${amount ? Math.min(4, Math.ceil(amount / max * 4)) : 0}${inMonth ? '' : ' outside'}`; cell.setAttribute('role', 'gridcell'); cell.setAttribute('aria-label', `${key}: ${amount ? money(amount) : 'No spending'}`); cell.title = `${new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date)} · ${amount ? money(amount) : 'No spending'}`; cell.disabled = !inMonth;
    cell.onclick = () => { selectedHeatmapDate = key; $('#date-from').value = key; $('#date-to').value = key; $('#search').value = ''; render(); $('#search').scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); };
    cell.append(document.createTextNode(inMonth ? String(date.getUTCDate()) : '')); cells.push(cell);
  }
  $('#heatmap').replaceChildren(...cells);
}
function applyHeatmapMonthRange() {
  const month = heatmapMonths[heatmapIndex];
  if (!month) return;
  const end = new Date(`${month}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
  selectedHeatmapDate = '';
  $('#date-from').value = `${month}-01`;
  $('#date-to').value = month === today.slice(0, 7) ? today : end.toISOString().slice(0, 10);
  render();
}
function edit(transaction) {
  selected = transaction;
  reviewPosition = { x: window.scrollX, y: window.scrollY, tableX: $('.table-wrap').scrollLeft };
  $('#new-category').open = false; $('#category-name').value = '';
  const form = $('#edit-form');
  $('#edit-title').textContent = transaction.id ? 'Review transaction' : 'Add transaction';
  $('#manual-bank-field').hidden = Boolean(transaction.id);
  form.elements.bank.value = transaction.bank || 'Cash';
  $('#source').hidden = !transaction.id || transaction.id.startsWith('manual-') || transaction.id.startsWith('statement-');
  for (const key of ['date', 'merchant', 'type', 'category']) form.elements[key].value = transaction[key];
  form.elements.time.value = transaction.time || '';
  previewCategory();
  form.elements.amount.value = (transaction.amount / 100).toFixed(2);
  $('#review-note').textContent = [transaction.source_file ? `Statement: ${transaction.source_file}` : '', transaction.note].filter(Boolean).join(' — ');
  // Gmail search is more portable than assuming API message IDs are UI thread IDs.
  const senders = transaction.bank === 'ICICI' ? 'from:icici.bank.in' : transaction.bank === 'SBI' ? 'from:cbsalerts.sbi@alerts.sbi.bank.in' : '{from:hdfcbank.net from:hdfcbank.com from:alerts@hdfcbank.bank.in}';
  $('#source').href = 'https://mail.google.com/mail/u/0/#search/' + encodeURIComponent(`${senders} after:${transaction.date}`);
  $('#edit-error').textContent = ''; $('#editor').showModal();
}
$('#edit-form').onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  data.amount = Math.round(Number(data.amount) * 100);
  const save = $('#edit-form button[type=submit]'); save.disabled = true;
  try {
    const isNew = !selected.id;
    const result = await api(isNew ? '/api/transactions' : '/api/transactions/' + selected.id, isNew ? 'POST' : 'PATCH', data);
    if (isNew) transactions = [{ ...data, id: result.id, amount: data.amount, review: 0, note: '', split: null }, ...transactions];
    else Object.assign(selected, data, { review: 0, note: '' });
    render();
    features.setTransactions(transactions);
    $('#editor').close();
    restoreReviewPosition();
    if (isNew) $('#message').textContent = 'Manual transaction saved and confirmed. Date and bank filters still apply.';
  }
  catch (error) { $('#edit-error').textContent = error.message; }
  finally { save.disabled = false; }
};
$('#add-transaction').onclick = () => edit({ date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), time: '', merchant: '', amount: 0, type: 'expense', category: 'Uncategorized', bank: 'Cash', note: 'Enter a transaction yourself. It will count toward your totals immediately.' });
$('#cancel').onclick = () => $('#editor').close();
function restoreReviewPosition() {
  if (!reviewPosition) return;
  const position = reviewPosition;
  const button = [...$('#rows').querySelectorAll('button')].find(b => b.dataset.transactionId === selected?.id);
  button?.focus({ preventScroll: true });
  window.scrollTo({ left: position.x, top: position.y, behavior: 'instant' });
  $('.table-wrap').scrollLeft = position.tableX;
}
$('#editor').addEventListener('close', restoreReviewPosition);
$('#category-select').onchange = previewCategory;
const clearDayFilter = document.createElement('button'); clearDayFilter.id = 'clear-day-filter'; clearDayFilter.className = 'secondary clear-day-filter'; clearDayFilter.type = 'button'; clearDayFilter.textContent = 'Clear date filter'; clearDayFilter.hidden = true; clearDayFilter.onclick = () => { selectedHeatmapDate = ''; $('#date-from').value = ''; $('#date-to').value = ''; render(); };
$('#review-summary').append(clearDayFilter);
const clearDateSelection = () => { selectedHeatmapDate = ''; render(); };
$('#date-from').oninput = clearDateSelection; $('#date-to').oninput = clearDateSelection; $('#search').oninput = render;
$('#bank-filter').onchange = render;
$('#heatmap-prev').onclick = () => { heatmapIndex--; applyHeatmapMonthRange(); };
$('#heatmap-next').onclick = () => { heatmapIndex++; applyHeatmapMonthRange(); };
$('#all-dates').onclick = () => { selectedHeatmapDate = ''; $('#date-from').value = ''; $('#date-to').value = ''; render(); };
function toggleSidebar(open) {
  $('#profile-sidebar').classList.toggle('is-open', open);
  $('#sidebar-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('#sidebar-close').focus({ preventScroll: true });
  else $('#sidebar-toggle').focus({ preventScroll: true });
}
$('#sidebar-toggle').onclick = () => toggleSidebar(!$('#profile-sidebar').classList.contains('is-open'));
$('#sidebar-close').onclick = () => toggleSidebar(false);
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.querySelector('dialog[open]') && $('#profile-sidebar').classList.contains('is-open')) toggleSidebar(false); });
matchMedia('(max-width: 1050px)').addEventListener('change', () => { $('#profile-sidebar').classList.remove('is-open'); $('#sidebar-toggle').setAttribute('aria-expanded', 'false'); });
$('#sync').onclick = async () => {
  $('#sync').disabled = true; $('#message').textContent = 'Importing HDFC alerts. This may take a few minutes…';
  try { const result = await api('/api/sync', 'POST'); $('#message').textContent = `Processed ${result.imported} alerts. Clear expenses may be auto-confirmed; check remaining reviews. Skipped ${result.skipped} unsupported messages.`; }
  catch (error) { $('#message').textContent = error.message; }
  finally { await load().catch(error => { $('#message').textContent = error.message; }); }
};
$('#disconnect').onclick = async () => {
  try { await api('/api/disconnect', 'POST'); $('#message').textContent = 'Gmail disconnected. Your imported transactions remain on this computer.'; await load(); }
  catch (error) { $('#message').textContent = error.message; }
};
$('#add-category').onclick = async () => {
  const button = $('#add-category'); button.disabled = true;
  try {
    const category = await api('/api/categories', 'POST', { name: $('#category-name').value, icon: selectedIcon });
    await loadCategories(); $('#category-select').value = category.name;
    previewCategory();
    $('#new-category').open = false; $('#category-name').value = ''; $('#edit-error').textContent = '';
  } catch (error) { $('#edit-error').textContent = error.message; }
  finally { button.disabled = false; }
};
$('#auto-review').onchange = async event => {
  const input = event.target; input.disabled = true;
  try { await api('/api/auto-review', 'POST', { enabled: input.checked }); $('#message').textContent = 'Auto-review preference saved. It applies on your next sync; confirmed entries stay unchanged.'; }
  catch (error) { input.checked = !input.checked; $('#message').textContent = error.message; }
  finally { input.disabled = false; }
};
$('#message').textContent = new URLSearchParams(location.search).get('error') || '';
if (location.search) history.replaceState(null, '', '/');
const features = setupFeatures(api, load);
setupStatements(api, async result => {
  selectedHeatmapDate = ''; $('#date-from').value = ''; $('#date-to').value = ''; $('#bank-filter').value = ''; $('#search').value = '';
  $('#ledger-tab').click();
  $('#message').textContent = `Added ${result.imported} statement transactions. ${result.skipped} already imported rows skipped.`;
  await load();
}, () => categories);
load().catch(error => { $('#message').textContent = error.message; });
