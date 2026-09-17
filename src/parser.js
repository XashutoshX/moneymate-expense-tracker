// Parse only recognizable alert language. Unknown formats stay out of totals.
export function parseHdfc(text, receivedAt) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (/\b(OTP|one.time password|payment due|minimum amount due|statement ready)\b/i.test(clean)) return null;
  const debit = /\b(debited|spent|purchase|paid|withdrawn)\b/i.test(clean);
  const credit = /\b(credited|refund|reversed)\b/i.test(clean);
  if (!debit && !credit) return null;
  const amounts = [...clean.matchAll(/(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/gi)];
  const first = amounts[0]?.[1];
  const [whole, fraction = ''] = (first || '0').replaceAll(',', '').split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  const upi = clean.match(/\btowards\s+VPA\s+([^\s()]+)(?:\s+\(([^)]+)\))?\s+on\s+\d{1,2}-\d{1,2}-(?:\d{4}|\d{2})\b/i);
  const merchant = (upi?.[2] || upi?.[1])?.trim()
    || clean.match(/\btowards\s+(.{1,100}?)\s+on\s+\d{1,2}\s+[a-z]{3}/i)?.[1]?.trim()
    || clean.match(/(?:\bat\b|\bto\b)\s+([A-Za-z][A-Za-z0-9 *.@&_-]{2,55}?)(?=\s+(?:on|via|using|from|ref|for)\b|[.;]|$)/i)?.[1]?.trim() || 'HDFC transaction';
  const account = clean.match(/(?:ending|[xX*]{2,})\s*(\d{4})\b/)?.[1] || '';
  // Prefer the action attached to the amount; footer text may mention both debits and credits.
  // "Credit Card" describes the product, not money coming into the account.
  const action = clean.match(/(?:INR|Rs\.?|₹)\s*[\d,]+(?:\.\d{1,2})?\s+(?:(?:has been|is|was)\s+)?(credited|debited)\b/i)?.[1]?.toLowerCase();
  const type = /\b(refund|refunded|reversed)\b/i.test(clean) ? 'refund'
    : action === 'credited' ? 'income' : action === 'debited' ? 'expense'
    : credit ? 'income' : 'expense';
  const dateMatch = clean.match(/\bon\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec),?\s+(\d{4})\b/i);
  let transactionDate;
  const numericDate = clean.match(/\bon\s+(\d{1,2})-(\d{1,2})-(\d{4}|\d{2})\b/i);
  if (numericDate) {
    // Current bank alerts use two-digit years for 2000–2099.
    const year = numericDate[3].length === 2 ? `20${numericDate[3]}` : numericDate[3];
    const candidate = `${year}-${numericDate[2].padStart(2, '0')}-${numericDate[1].padStart(2, '0')}`;
    const parsed = new Date(candidate);
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate) transactionDate = candidate;
  }
  if (dateMatch) {
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(dateMatch[2].toLowerCase()) + 1;
    const candidate = `${dateMatch[3]}-${String(month).padStart(2, '0')}-${dateMatch[1].padStart(2, '0')}`;
    const parsed = new Date(candidate);
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate) transactionDate = candidate;
  }
  // Preserve the bank's calendar date instead of shifting it through UTC.
  const timeMatch = clean.match(/\bat\s+([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/i);
  return { date: transactionDate || new Date(receivedAt).toISOString().slice(0, 10), merchant, amount,
    time: timeMatch ? `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}:${timeMatch[3] || '00'}` : '',
    timeSource: timeMatch ? 'alert' : '',
    autoEligible: Boolean(transactionDate && account && amounts.length === 1 && debit && !credit
      && (upi || /\bCredit Card ending\s+\d{4}\s+towards\b/i.test(clean))),
    type, account, category: 'Uncategorized', review: 1,
    note: !first ? 'Amount missing; check the source email.' : amounts.length > 1 ? 'Multiple amounts. Verify amount and date.' : transactionDate ? 'Verify amount, type and transaction date.' : 'Verify amount, type and email receipt date.' };
}

export function messageText(payload) {
  const parts = [];
  function visit(part) {
    if (part.filename) return;
    if (part.body?.data && ['text/plain', 'text/html'].includes(part.mimeType)) {
      parts.push({ mime: part.mimeType, text: Buffer.from(part.body.data, 'base64url').toString('utf8') });
    }
    for (const child of part.parts || []) visit(child);
  }
  visit(payload);
  const plain = parts.filter(p => p.mime === 'text/plain');
  return (plain.length ? plain : parts).map(p => p.text).join(' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;|&#xA0;/gi, ' ').replace(/&amp;/g, '&');
}
