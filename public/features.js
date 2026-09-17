import { allocate, balances, myExpense } from './splits.js';
import { setupSneezy } from './sneezy.js';
import { renderAnalytics } from './analytics.js';
const $ = selector => document.querySelector(selector);
const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(value / 100);
const node = (tag, text, className) => { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; };

export function setupFeatures(api, reload) {
  const tableScroll = $('#transaction-scroll');
  function updateScrollButtons() {
    const rect = tableScroll.getBoundingClientRect();
    const visible = !$('#ledger-panel').hidden && rect.bottom > 0 && rect.top < innerHeight
      && tableScroll.scrollWidth > tableScroll.clientWidth + 1 && !document.querySelector('dialog[open]');
    $('#table-left').hidden = $('#table-right').hidden = !visible;
    $('#table-left').disabled = tableScroll.scrollLeft <= 1;
    $('#table-right').disabled = tableScroll.scrollLeft + tableScroll.clientWidth >= tableScroll.scrollWidth - 1;
  }
  for (const [id, direction] of [['#table-left', -1], ['#table-right', 1]]) $(id).onclick = () => tableScroll.scrollBy({ left: direction * Math.max(200, tableScroll.clientWidth * 0.65), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  tableScroll.addEventListener('scroll', updateScrollButtons, { passive: true });
  window.addEventListener('scroll', updateScrollButtons, { passive: true });
  window.addEventListener('resize', updateScrollButtons);
  new ResizeObserver(updateScrollButtons).observe(tableScroll);
  new MutationObserver(updateScrollButtons).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  let profile = {}, people = [], transactions = [], activeSplit, photo = '', splitPosition;
  const sneezy = setupSneezy(() => transactions, (month, search) => {
    $('#date-from').value = month + '-01';
    const end = new Date(month + '-01T00:00:00Z'); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
    $('#date-to').value = end.toISOString().slice(0, 10);
    $('#bank-filter').value = ''; $('#search').value = search;
    $('#search').dispatchEvent(new Event('input')); $('#ledger-tab').click();
    $('#search').scrollIntoView({ block: 'center' });
  });
  $('#export-people-pdf').onclick = async () => {
    const button = $('#export-people-pdf'), status = $('#export-people-status');
    button.disabled = true; status.textContent = 'Preparing PDF...';
    try {
      const response = await fetch('/api/export/people.pdf');
      if (!response.ok) throw new Error('Could not export the PDF. Please try again.');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = 'moneymante-people-balances.pdf';
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      status.textContent = 'PDF downloaded. Includes all-time confirmed splits.';
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  };
  function personName(id) { return id === 'me' ? 'You' : people.find(p => p.id === id)?.name || 'Unknown person'; }
  async function refresh(rows) {
    transactions = rows;
    [profile, people] = await Promise.all([api('/api/profile'), api('/api/people')]);
    $('#profile-name').textContent = profile.name || 'Your profile';
    $('#profile-email').textContent = profile.email || 'Connect Gmail';
    $('#profile-photo').hidden = !profile.photo; $('#profile-initial').hidden = Boolean(profile.photo);
    if (profile.photo) $('#profile-photo').src = profile.photo; else $('#profile-photo').removeAttribute('src');
    $('#profile-initial').textContent = (profile.name || 'You').slice(0, 1).toUpperCase();
    const net = balances(transactions, people);
    $('#people-list').replaceChildren(...people.map(person => {
      const item = node('div', '', 'person-balance');
      const value = net.get(person.id) || 0;
      item.append(node('strong', person.name), node('span', value > 0 ? `Owes you ${money(value)}` : value < 0 ? `You owe ${money(-value)}` : 'Settled / no balance', value < 0 ? 'owed' : 'receivable'));
      return item;
    }));
    if (!people.length) $('#people-list').append(node('p', 'Add someone to split an expense.', 'muted'));
    renderInsights();
    sneezy.render();
    updateScrollButtons();
  }
  function clear() {
    profile = {}; people = []; transactions = [];
    $('#profile-name').textContent = 'Your profile'; $('#profile-email').textContent = 'Connect Gmail';
    $('#profile-photo').hidden = true; $('#profile-photo').removeAttribute('src'); $('#profile-initial').hidden = false; $('#profile-initial').textContent = 'Y';
    $('#people-list').replaceChildren(); $('#insight-cards').replaceChildren(); $('#trend-chart').replaceChildren(); $('#trend-table').replaceChildren(); $('#category-breakdown').replaceChildren();
    $('#sneezy-summary').textContent = ''; $('#sneezy-saving').textContent = ''; $('#sneezy-actions').replaceChildren(); $('#sneezy-flags').replaceChildren();
    updateScrollButtons();
  }
  $('#person-form').onsubmit = async event => {
    event.preventDefault();
    try { await api('/api/people', 'POST', { name: $('#person-name').value }); $('#person-name').value = ''; $('#person-error').textContent = ''; $('#person-form').hidden = true; $('#add-person-toggle').setAttribute('aria-expanded', 'false'); await reload(); }
    catch (error) { $('#person-error').textContent = error.message; }
  };
  $('#add-person-toggle').onclick = () => { $('#person-form').hidden = !$('#person-form').hidden; $('#add-person-toggle').setAttribute('aria-expanded', String(!$('#person-form').hidden)); if (!$('#person-form').hidden) $('#person-name').focus({ preventScroll: true }); };
  $('#edit-profile').onclick = () => {
    $('#profile-form').elements.name.value = profile.name || ''; photo = profile.photo || '';
    $('#photo-file').value = ''; $('#profile-error').textContent = ''; $('#profile-editor').showModal();
  };
  $('#remove-photo').onclick = () => { photo = ''; $('#photo-file').value = ''; $('#profile-error').textContent = 'Photo will be removed when you save.'; };
  $('#profile-cancel').onclick = () => $('#profile-editor').close();
  $('#profile-form').onsubmit = async event => {
    event.preventDefault();
    try {
      const file = $('#photo-file').files[0];
      if (file) {
        if (file.size > 250000 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG or WebP under 250 KB.');
        photo = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
      }
      await api('/api/profile', 'POST', { name: $('#profile-form').elements.name.value, photo });
      await reload(); $('#profile-editor').close();
    } catch (error) { $('#profile-error').textContent = error.message; }
  };
  function participants() {
    return [...$('#split-people').children].filter(row => row.querySelector('input[type=checkbox]').checked)
      .map(row => { const value = row.querySelector('input[type=number]').value; return { id: row.dataset.id, percent: value, exact: value, units: value }; });
  }
  function updateSplit() {
    const chosen = participants(), previous = $('#split-payer').value || activeSplit?.split?.paidBy || 'me';
    const count = $('#split-people').children.length;
    $('#split-select-all').checked = count > 0 && chosen.length === count;
    $('#split-select-all').indeterminate = chosen.length > 0 && chosen.length < count;
    const payers = [{ id: 'me' }, ...people];
    $('#split-payer').replaceChildren(...payers.map(p => new Option(personName(p.id), p.id)));
    $('#split-payer').value = payers.some(p => p.id === previous) ? previous : 'me';
    for (const row of $('#split-people').children) {
      const mode = $('#split-mode').value, input = row.querySelector('input[type=number]');
      row.querySelector('.percent-label').hidden = mode === 'equal';
      row.querySelector('.value-unit').textContent = mode === 'exact' ? 'INR' : mode === 'shares' ? 'Shares' : '%';
      input.disabled = !row.querySelector('input[type=checkbox]').checked || mode === 'equal';
      input.max = mode === 'percentage' ? '100' : '';
      input.setAttribute('aria-label', `${personName(row.dataset.id)} ${mode === 'exact' ? 'amount in rupees' : mode}`);
    }
    try {
      const shares = allocate(activeSplit.amount, chosen, $('#split-mode').value);
      $('#split-preview').replaceChildren(...shares.map(p => node('p', `${personName(p.id)}: ${money(p.amount)}`)));
      $('#split-error').textContent = ''; $('#split-save').disabled = false;
    } catch (error) { $('#split-preview').replaceChildren(); $('#split-error').textContent = error.message; $('#split-save').disabled = true; }
  }
  function openSplit(t) {
    activeSplit = t; splitPosition = { x: scrollX, y: scrollY };
    $('#split-title').textContent = `${t.merchant} · ${money(t.amount)}`;
    $('#split-mode').value = t.split?.mode || 'equal';
    $('#split-payer').replaceChildren();
    $('#split-people').replaceChildren(...[{ id: 'me', name: 'You' }, ...people].map(person => {
      const row = node('div', '', 'split-person'); row.dataset.id = person.id;
      const label = node('label', ''), checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      const saved = t.split?.shares.find(p => p.id === person.id);
      checkbox.checked = t.split ? Boolean(saved) : person.id === 'me';
      label.append(checkbox, document.createTextNode(person.name));
      const percentLabel = node('label', '', 'percent-label'), percent = document.createElement('input'); percent.type = 'number'; percent.min = '0'; percent.step = '0.01'; percent.value = t.split?.mode === 'exact' ? ((saved?.amount || 0) / 100).toFixed(2) : t.split?.mode === 'shares' ? String(saved?.units || 0) : saved?.percent?.toFixed(2) || '0';
      percentLabel.append(node('span', '%', 'value-unit'));
      percent.setAttribute('aria-label', `${person.name} percentage`); percentLabel.append(percent);
      row.append(label, percentLabel); row.oninput = updateSplit; return row;
    }));
    $('#split-remove').hidden = !t.split;
    updateSplit(); $('#split-editor').showModal();
  }
  $('#split-mode').onchange = () => { for (const row of $('#split-people').children) row.querySelector('input[type=number]').value = $('#split-mode').value === 'shares' ? '1' : '0'; updateSplit(); };
  $('#split-select-all').onchange = event => { for (const row of $('#split-people').children) row.querySelector('input[type=checkbox]').checked = event.target.checked; updateSplit(); };
  $('#split-cancel').onclick = () => $('#split-editor').close();
  $('#split-editor').onclose = () => { if (splitPosition) window.scrollTo({ left: splitPosition.x, top: splitPosition.y, behavior: 'instant' }); };
  $('#split-form').onsubmit = async event => {
    event.preventDefault();
    try { await api('/api/splits/' + activeSplit.id, 'POST', { mode: $('#split-mode').value, paidBy: $('#split-payer').value, participants: participants() }); await reload(); $('#split-editor').close(); }
    catch (error) { $('#split-error').textContent = error.message; }
  };
  $('#split-remove').onclick = async () => {
    try { await api('/api/splits/' + activeSplit.id, 'DELETE'); await reload(); $('#split-editor').close(); }
    catch (error) { $('#split-error').textContent = error.message; }
  };
  for (const view of ['ledger', 'deep', 'sneezy']) $('#' + view + '-tab').onclick = () => {
    for (const name of ['ledger', 'deep', 'sneezy']) {
      $('#' + name + '-panel').hidden = name !== view;
      $('#' + name + '-tab').setAttribute('aria-pressed', String(name === view));
    }
    renderInsights(); sneezy.render(); updateScrollButtons();
  };
  $('#deep-month').value = $('#date-to').value.slice(0, 7); $('#deep-month').oninput = renderInsights;
  function renderInsights() {
    const end = $('#deep-month').value;
    if (!/^\d{4}-\d{2}$/.test(end)) return;
    const dashboard = $('#analytics-dashboard') || (() => {
      const element = document.createElement('div'); element.id = 'analytics-dashboard';
      $('#deep-panel').querySelectorAll(':scope > .analytics-card, :scope > #insight-cards').forEach(legacy => { legacy.hidden = true; });
      $('#deep-panel').append(element); return element;
    })();
    renderAnalytics(dashboard, transactions, end, myExpense);
    return;
    const months = Array.from({ length: 6 }, (_, i) => { const d = new Date(`${end}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 5 + i); return d.toISOString().slice(0, 7); });
    const rows = months.map(month => {
      const current = transactions.filter(t => !t.review && t.date.startsWith(month));
      return { month, expense: current.filter(t => t.type === 'expense').reduce((sum, t) => sum + myExpense(t), 0), income: current.filter(t => ['income', 'refund'].includes(t.type)).reduce((sum, t) => sum + t.amount, 0) };
    });
    const current = rows[5], previous = rows[4];
    const pending = transactions.filter(t => t.review && t.date.startsWith(end)).length;
    $('#insight-cards').replaceChildren(...[
      ['Your expenses', money(current.expense), 'Your share of confirmed expenses'],
      ['Money received', money(current.income), 'Confirmed income and refunds'],
      ['Received minus expenses', money(current.income - current.expense), `${pending} pending reviews excluded`]
    ].map(([label, value, sub]) => { const article = node('article', ''); article.append(node('p', label), node('strong', value), node('small', sub)); return article; }));
    const max = Math.max(1, ...rows.flatMap(r => [r.expense, r.income]));
    const svgNS = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('viewBox', '0 0 660 220'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Six-month income and expense chart. Exact values in table below.');
    rows.forEach((r, i) => {
      [r.expense, r.income].forEach((value, j) => { const rect = document.createElementNS(svgNS, 'rect'); const height = value / max * 170; rect.setAttribute('x', String(i * 110 + 25 + j * 30)); rect.setAttribute('y', String(180 - height)); rect.setAttribute('width', '24'); rect.setAttribute('height', String(height)); rect.setAttribute('fill', j ? '#8a8a82' : '#5748b5'); svg.append(rect); });
      const label = document.createElementNS(svgNS, 'text'); label.setAttribute('x', String(i * 110 + 15)); label.setAttribute('y', '207'); label.setAttribute('font-size', '14'); label.textContent = r.month; svg.append(label);
    });
    $('#trend-chart').replaceChildren(svg);
    const table = document.createElement('table'); const head = document.createElement('tr'); for (const title of ['Month', 'Your expenses', 'Money received']) head.append(node('th', title)); table.append(head);
    for (const r of rows) { const tr = document.createElement('tr'); for (const value of [r.month, money(r.expense), money(r.income)]) tr.append(node('td', value)); table.append(tr); }
    $('#trend-table').replaceChildren(table);
    const grouped = new Map(); for (const t of transactions.filter(t => !t.review && t.type === 'expense' && t.date.startsWith(end))) grouped.set(t.category, (grouped.get(t.category) || 0) + myExpense(t));
    const sorted = [...grouped].sort((a, b) => b[1] - a[1]);
    $('#category-breakdown').replaceChildren(node('p', previous.expense ? `Your expenses ${current.expense >= previous.expense ? 'increased' : 'decreased'} ${Math.abs((current.expense - previous.expense) / previous.expense * 100).toFixed(1)}% versus the previous month.` : 'No confirmed expenses in the previous month to compare.'));
    if (!sorted.length) $('#category-breakdown').append(node('p', 'No confirmed expenses for this month.'));
    for (const [category, amount] of sorted) { const row = node('div', '', 'breakdown-row'); const bar = document.createElement('progress'); bar.max = current.expense || 1; bar.value = amount; row.append(node('span', category), bar, node('strong', money(amount))); $('#category-breakdown').append(row); }
  }
  return { refresh, clear, openSplit };
}
