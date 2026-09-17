// Allocate integer paise with largest remainders so shares always equal the bill.
export function allocate(amount, participants, mode) {
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Array.isArray(participants) || participants.length < 1 || participants.length > 30
    || participants.some(p => !p || typeof p.id !== 'string') || new Set(participants.map(p => p.id)).size !== participants.length) throw new Error('Choose at least one person, with no duplicates.');
  if (!['equal', 'exact', 'percentage', 'shares'].includes(mode)) throw new Error('Choose a valid split method.');
  const decimal = value => {
    const text = String(value ?? '');
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('Enter non-negative values with at most two decimal places.');
    const [whole, fraction = ''] = text.split('.');
    const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(result)) throw new Error('Value is too large.');
    return result;
  };
  const weights = participants.map(p => mode === 'equal' ? 1 : decimal(mode === 'exact' ? p.exact : mode === 'shares' ? p.units : p.percent));
  if (mode === 'exact') {
    if (weights.reduce((a, b) => a + b, 0) !== amount) throw new Error('Exact amounts must total the expense amount.');
    return participants.map((p, i) => ({ id: p.id, amount: weights[i] }));
  }
  if (mode === 'percentage' && weights.reduce((a, b) => a + b, 0) !== 10000) throw new Error('Percentages must total 100%.');
  const total = weights.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Enter at least one positive share.');
  const shares = participants.map((p, i) => ({ id: p.id, amount: Number(BigInt(amount) * BigInt(weights[i]) / BigInt(total)), percent: mode === 'percentage' ? weights[i] / 100 : weights[i] / total * 100, ...(mode === 'shares' ? { units: weights[i] / 100 } : {}) }));
  let remainder = amount - shares.reduce((s, p) => s + p.amount, 0);
  const order = weights.map((w, i) => ({ i, remainder: Number(BigInt(amount) * BigInt(w) % BigInt(total)) })).sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (let i = 0; i < remainder; i++) shares[order[i].i].amount++;
  return shares;
}

export function balances(transactions, people) {
  const result = new Map(people.map(p => [p.id, 0]));
  for (const t of transactions) {
    if (t.review || t.type !== 'expense' || !t.split) continue;
    if (t.split.paidBy === 'me') {
      for (const share of t.split.shares) if (share.id !== 'me') result.set(share.id, (result.get(share.id) || 0) + share.amount);
    } else {
      const mine = t.split.shares.find(p => p.id === 'me')?.amount || 0;
      result.set(t.split.paidBy, (result.get(t.split.paidBy) || 0) - mine);
    }
  }
  return result;
}

export function myExpense(t) {
  return t.split ? t.split.shares.find(p => p.id === 'me')?.amount || 0 : t.amount;
}
