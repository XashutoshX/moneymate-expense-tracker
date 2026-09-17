import test from 'node:test';
import assert from 'node:assert/strict';
import { bankFromSender, parseBank } from '../src/banks.js';

test('recognizes bank sender domains without matching lookalikes', () => {
  assert.equal(bankFromSender('ICICI <alerts@icici.bank.in>'), 'ICICI');
  assert.equal(bankFromSender('alerts@icici.bank.in.example.com'), null);
  assert.equal(bankFromSender('alerts@fakeicici.bank.in'), null);
  assert.equal(bankFromSender('alerts@hdfcbank.bank.in'), 'HDFC');
  assert.equal(bankFromSender('cbsalerts.sbi@alerts.sbi.bank.in'), 'SBI');
  assert.equal(bankFromSender('cbsalerts.sbi@alerts.sbi.bank.in.example.com'), null);
});
test('ICICI debit and credit parsing stays pending verification', () => {
  const debit = parseBank('ICICI', 'Rs.100.00 debited from account ending 1234 on 10-09-26.', Date.now());
  assert.equal(debit.amount, 10000);
  assert.equal(debit.type, 'expense');
  assert.equal(debit.autoEligible, false);
  assert.equal(parseBank('ICICI', 'INR 200 credited to account ending 1234.', Date.now()).type, 'income');
});

test('SBI debit parsing stays pending verification', () => {
  const transaction = parseBank('SBI', 'Rs.100.00 debited from account ending 1234 on 10-09-26.', Date.now());
  assert.equal(transaction.amount, 10000);
  assert.equal(transaction.type, 'expense');
  assert.equal(transaction.merchant, 'SBI transaction');
  assert.equal(transaction.autoEligible, false);
});
