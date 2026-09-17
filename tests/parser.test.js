import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHdfc, messageText } from '../src/parser.js';

export const alert = `Dear Customer,
Greetings from HDFC Bank.
We would like to inform you that Rs. 757.00 has been debited from your HDFC Bank Credit Card ending 5953 towards RSP*BLINK COMMERCE PVT on 08 Sep, 2026 at 16:52:46.
To check your available balance, outstanding amount, or view recent transactions, you may use Mycards.
Important Note: If you did not authorise this transaction, please act immediately.
Call HDFC Bank Helpline at 1800 258 6161. Via SMS: BLOCK CC 5953. Send it to 7308080808.`;

const upiAlert = `Dear Customer, Greetings from HDFC Bank!
Rs.22.00 is debited from your account ending 6995 towards VPA gpay-12197468113@okbizaxis (SRI DEVI BAKERS) on 09-09-26.
UPI transaction reference no.: 661821875417.
If you did not authorize this transaction, please report it immediately at 1800 258 6161 or SMS 'BLOCK UPI' to 7308080808.`;

test('credited amount remains income when footer mentions purchases or debits', () => {
  const result = parseHdfc('Rs.500.00 has been credited to your account ending 6995 on 09-09-26. Check recent purchases and amounts debited using NetBanking.', Date.now());
  assert.equal(result.type, 'income');
  assert.equal(result.amount, 50000);
});

test('credit card debit remains an expense even when footer mentions credited amounts', () => {
  assert.equal(parseHdfc(alert + ' Check credited amounts online.', Date.now()).type, 'expense');
});

test('parses UPI merchant, account and Indian numeric date', () => {
  const result = parseHdfc(upiAlert, Date.UTC(2026, 8, 10));
  assert.equal(result.amount, 2200);
  assert.equal(result.merchant, 'SRI DEVI BAKERS');
  assert.equal(result.account, '6995');
  assert.equal(result.date, '2026-09-09');
  assert.equal(result.type, 'expense');
  assert.equal(result.time, '');
});

test('UPI without merchant name falls back to VPA and supports four-digit years', () => {
  const result = parseHdfc(upiAlert.replace(' (SRI DEVI BAKERS)', '').replace('09-09-26', '09-09-2026'), Date.UTC(2026, 8, 10));
  assert.equal(result.merchant, 'gpay-12197468113@okbizaxis');
  assert.equal(result.date, '2026-09-09');
});

test('invalid UPI date falls back to receipt date', () => {
  assert.equal(parseHdfc(upiAlert.replace('09-09-26', '31-02-26'), Date.UTC(2026, 8, 10)).date, '2026-09-10');
});

test('extracts HDFC credit card alert with bank date and merchant punctuation', () => {
  const result = parseHdfc(alert, Date.UTC(2026, 8, 10));
  assert.equal(result.amount, 75700);
  assert.equal(result.merchant, 'RSP*BLINK COMMERCE PVT');
  assert.equal(result.account, '5953');
  assert.equal(result.date, '2026-09-08');
  assert.equal(result.type, 'expense');
  assert.equal(result.time, '16:52:46');
});

test('parses HTML bold formatting and nonbreaking spaces', () => {
  const html = alert.replace('Rs. 757.00', '<b>Rs.&#160;757.00</b>').replace('5953', '<b>5953</b>');
  const text = messageText({ mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } });
  assert.equal(parseHdfc(text, Date.now()).amount, 75700);
  assert.equal(parseHdfc(text, Date.now()).account, '5953');
});

test('extracts INR in paise and requires review', () => {
  const result = parseHdfc('Rs. 1,234.50 debited from a/c XX1234 to AMAZON on 10 Sep.', Date.UTC(2026, 8, 10));
  assert.equal(result.amount, 123450);
  assert.equal(result.account, '1234');
  assert.equal(result.type, 'expense');
  assert.equal(result.review, 1);
});
test('does not import OTPs or statements as expenses', () => {
  assert.equal(parseHdfc('OTP for purchase INR 400 is 123456', Date.now()), null);
  assert.equal(parseHdfc('Minimum amount due INR 500. Last paid INR 200.', Date.now()), null);
});
test('refunds are separate from expenses', () => {
  assert.equal(parseHdfc('Refund of INR 120 credited to account', Date.now()).type, 'refund');
});
test('ambiguous amounts are flagged', () => {
  assert.match(parseHdfc('INR 50 debited. Balance INR 5000', Date.now()).note, /Multiple amounts/);
});
test('MIME alternatives do not duplicate email text', () => {
  const result = messageText({ parts: [
    { mimeType: 'text/plain', body: { data: Buffer.from('INR 50 debited').toString('base64url') } },
    { mimeType: 'text/html', body: { data: Buffer.from('<p>INR 50 debited</p>').toString('base64url') } }
  ] });
  assert.equal(result, 'INR 50 debited');
});
