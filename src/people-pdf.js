import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import { balances } from '../public/splits.js';

const money = value => `INR ${(value / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const balanceText = value => value > 0 ? `Owes you ${money(value)}` : value < 0 ? `You owe ${money(-value)}` : 'No net balance';

export function peopleReport(rows, people) {
  const confirmed = rows.filter(t => !t.review && t.type === 'expense' && t.split);
  const net = balances(confirmed, people);
  const name = id => id === 'me' ? 'You' : people.find(p => p.id === id)?.name || 'Unknown person';
  return people.map(person => ({
    ...person, balance: net.get(person.id) || 0,
    transactions: confirmed.filter(t => t.split.paidBy === person.id || t.split.shares.some(s => s.id === person.id))
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
      .map(t => ({ date: t.date, merchant: t.merchant, total: t.amount, payer: name(t.split.paidBy),
        share: t.split.shares.find(s => s.id === person.id)?.amount || 0,
        balance: balances([t], [person]).get(person.id) || 0 }))
  }));
}

export function createPeoplePdf(rows, people, profileName = '', now = new Date()) {
  const report = peopleReport(rows, people);
  const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true, info: { Title: 'People & balances', Author: 'Moneymante' } });
  const chunks = [];
  const result = new Promise((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const font = ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find(existsSync);
  if (font) doc.font(font);
  const width = doc.page.width - 84;
  const bottom = doc.page.height - 65;
  const text = (value, size = 10, color = '#25252b') => doc.fontSize(size).fillColor(color).text(value, { width, lineGap: 3 });
  const space = height => { if (doc.y + height > bottom) doc.addPage(); };
  text('MONEYMANTE', 10, '#5748b5');
  text('People & balances', 25);
  text(`${profileName ? `Prepared for ${profileName} | ` : ''}Generated ${new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' }).format(now)}`, 9, '#656570');
  doc.moveDown();
  text('All-time confirmed splits. Amounts are in INR. Balances are between you and each person; debts between other people are not included. Transactions may appear under more than one person.', 10, '#656570');
  doc.moveDown();
  const receivable = report.reduce((sum, p) => sum + Math.max(0, p.balance), 0);
  const payable = report.reduce((sum, p) => sum + Math.max(0, -p.balance), 0);
  text(`People owe you: ${money(receivable)}`, 13);
  text(`You owe people: ${money(payable)}`, 13);
  doc.moveDown();
  if (!report.length) text('No people added yet. Add people and split confirmed expenses to include them in this report.');
  for (const person of report) {
    space(65);
    text(person.name, 13, '#5748b5');
    text(`${balanceText(person.balance)} | ${person.transactions.length} involved transaction(s)`);
    doc.moveDown(0.5);
  }
  for (const person of report) {
    doc.addPage();
    text(person.name, 22, '#5748b5');
    text(balanceText(person.balance), 14);
    doc.moveDown();
    if (!person.transactions.length) { text('No confirmed split transactions for this person.'); continue; }
    for (const transaction of person.transactions) {
      const title = `${transaction.date} | ${transaction.merchant}`;
      doc.fontSize(12);
      const height = doc.heightOfString(title, { width, lineGap: 3 }) + 85;
      if (doc.y + height > bottom) {
        doc.addPage();
        text(`${person.name} (continued)`, 15, '#5748b5');
        doc.moveDown();
      }
      text(title, 12);
      text(`Bill total: ${money(transaction.total)} | Their share: ${money(transaction.share)}`);
      text(`Paid by: ${transaction.payer}`);
      text(transaction.balance === 0 ? 'No balance change between you and this person' : balanceText(transaction.balance), 10, '#5748b5');
      doc.moveDown();
    }
  }
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.fontSize(8).fillColor('#656570').text(`Moneymante | People & balances | Page ${i + 1} of ${range.count}`, 42, doc.page.height - 40, { width, lineBreak: false });
    doc.page.margins.bottom = 42;
  }
  doc.end();
  return result;
}
