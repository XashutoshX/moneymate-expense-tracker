import { parseHdfc } from './parser.js';

export function bankFromSender(sender) {
  const address = (sender.match(/<([^<>]+)>/)?.[1] || sender).trim().toLowerCase();
  if (/^[^\s@]+@(?:[a-z0-9-]+\.)*icici\.bank\.in$/.test(address)) return 'ICICI';
  if (/^[^\s@]+@(?:[a-z0-9-]+\.)*hdfcbank\.(?:net|com)$/.test(address) || address === 'alerts@hdfcbank.bank.in') return 'HDFC';
  if (address === 'cbsalerts.sbi@alerts.sbi.bank.in') return 'SBI';
  return null;
}

export function parseBank(bank, text, receivedAt) {
  const transaction = parseHdfc(text, receivedAt);
  if (!transaction) return null;
  if (bank === 'ICICI' || bank === 'SBI') {
    // Shared debit/credit extraction is provisional until real ICICI templates are verified.
    transaction.autoEligible = false;
    if (transaction.merchant === 'HDFC transaction') transaction.merchant = `${bank} transaction`;
    transaction.note = `${bank} alert: verify the amount, merchant, date and type against the source email.`;
  }
  return transaction;
}
