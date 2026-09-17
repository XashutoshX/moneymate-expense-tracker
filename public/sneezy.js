import { myExpense } from './splits.js';
const money = amount => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(amount / 100);

export function assess(rows, month, cutPercent = 10) {
  const selected = rows.filter(t => t.date.startsWith(month));
  const confirmed = selected.filter(t => !t.review);
  const expenses = confirmed.filter(t => t.type === 'expense');
  const total = expenses.reduce((sum, t) => sum + myExpense(t), 0);
  const income = confirmed.filter(t => t.type === 'income').reduce((sum, t) => sum + t.amount, 0);
  const refunds = confirmed.filter(t => t.type === 'refund').reduce((sum, t) => sum + t.amount, 0);
  const pending = selected.filter(t => t.review).length;
  const categories = new Map();
  for (const t of expenses) categories.set(t.category, (categories.get(t.category) || 0) + myExpense(t));
  const flexible = ['Food & dining', 'Shopping', 'Entertainment'];
  const adjustable = [...categories].filter(([category]) => flexible.includes(category));
  const baseline = adjustable.reduce((sum, [, amount]) => sum + amount, 0);
  const percent = Number.isFinite(Number(cutPercent)) ? Math.min(50, Math.max(0, Number(cutPercent))) : 10;
  const suggestions = [], flags = [];
  if (pending) flags.push({ title: `${pending} transactions still need review`, text: 'These are excluded from this analysis. Confirm their amount, type and category before making spending decisions.', search: '' });
  if (!income) flags.push({ title: 'No income recorded for this month', text: 'Spending alone cannot tell us whether you are over budget. Add missing income or sync and review incoming credits.', search: '' });
  else if (total > income + refunds) flags.push({ title: 'Recorded expenses exceed recorded money received', text: `${money(total)} of personal expenses versus ${money(income)} income and ${money(refunds)} refunds. Check missing entries first; this is not your bank balance.`, search: '' });
  const uncategorized = categories.get('Uncategorized') || 0;
  if (uncategorized) flags.push({ title: 'Some spending is uncategorized', text: `${money(uncategorized)} needs a category to make the recommendations more useful.`, search: 'Uncategorized' });
  const seen = new Map(); let duplicates = 0;
  for (const t of expenses) {
    const key = [t.date, t.merchant.trim().toLowerCase(), t.amount].join('|');
    if (seen.has(key)) duplicates++; else seen.set(key, true);
  }
  if (duplicates) flags.push({ title: `${duplicates} possible duplicate entries`, text: 'Some expenses have the same date, merchant and original amount. They may be legitimate repeat purchases; check before marking any as duplicates.', search: '' });
  for (const [category, amount] of adjustable.sort((a, b) => b[1] - a[1])) {
    if (amount <= 0) continue;
    suggestions.push({ title: `Review ${category.toLowerCase()}`, text: `Your share was ${money(amount)}. A ${percent}% reduction on a similar amount would free up ${money(Math.round(amount * percent / 100))}. Review which purchases are optional before choosing a limit.`, search: category });
  }
  const byMerchant = new Map();
  for (const t of expenses.filter(t => myExpense(t) > 0)) {
    const key = t.merchant.trim().toLowerCase(); const item = byMerchant.get(key) || { name: t.merchant, count: 0, amount: 0 };
    item.count++; item.amount += myExpense(t); byMerchant.set(key, item);
  }
  const repeat = [...byMerchant.values()].filter(m => m.count >= 3).sort((a, b) => b.amount - a.amount)[0];
  if (repeat) suggestions.push({ title: `Repeated spending at ${repeat.name}`, text: `${repeat.count} recorded purchases add up to ${money(repeat.amount)} of your share. Check whether fewer visits or orders would help; repetition alone does not imply a subscription.`, search: repeat.name });
  const largest = [...expenses].sort((a, b) => myExpense(b) - myExpense(a))[0];
  if (largest && total > 0 && myExpense(largest) >= total * 0.4) flags.push({ title: 'One expense dominates the month', text: `${largest.merchant} accounts for ${Math.round(myExpense(largest) / total * 100)}% (${money(myExpense(largest))}) of your recorded personal spending. Check the amount and split; it may be a planned purchase.`, search: largest.merchant });
  return { total, income, refunds, pending, count: expenses.length, saving: Math.round(baseline * percent / 100), suggestions, flags };
}

export function setupSneezy(getRows, inspect) {
  const $ = s => document.querySelector(s);
  const el = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };
  $('#sneezy-month').value = $('#date-to').value.slice(0, 7);
  function render() {
    const month = $('#sneezy-month').value;
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    const result = assess(getRows(), month, $('#sneezy-cut').value);
    $('#sneezy-cut-label').textContent = `${$('#sneezy-cut').value}%`;
    $('#sneezy-summary').textContent = `${result.count} confirmed expenses · Your share ${money(result.total)} · Recorded income ${money(result.income)} · Refunds ${money(result.refunds)}`;
    $('#sneezy-saving').textContent = money(result.saving);
    function cards(target, items, empty) {
      $(target).replaceChildren();
      if (!items.length) $(target).append(el('p', empty));
      for (const item of items) {
        const card = el('article', ''); card.className = 'analytics-card';
        card.append(el('h3', item.title), el('p', item.text));
        const button = el('button', 'Inspect transactions'); button.className = 'secondary';
        button.onclick = () => inspect(month, item.search); card.append(button); $(target).append(card);
      }
    }
    cards('#sneezy-actions', result.suggestions, 'Not enough categorized spending to suggest specific cutbacks. Add or review transactions to get started.');
    cards('#sneezy-flags', result.flags, 'No flags from these checks. This does not guarantee that every transaction is correct or affordable.');
  }
  $('#sneezy-month').oninput = render; $('#sneezy-cut').oninput = render;
  return { render };
}
