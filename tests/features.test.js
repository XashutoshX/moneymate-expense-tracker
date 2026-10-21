import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('profile, people, cards and splits persist in SQLite and pending splits are rejected', () => {
  const directory = mkdtempSync(join(tmpdir(), 'expense-feature-test-'));
  const script = `
    import assert from 'node:assert/strict';
    import { featureRequest, listTransactions } from ${JSON.stringify(new URL('../src/features.js', import.meta.url).href)};
    import { balances } from ${JSON.stringify(new URL('../public/splits.js', import.meta.url).href)};
    import { db, userId } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
    import { addManualTransaction } from ${JSON.stringify(new URL('../src/manual.js', import.meta.url).href)};
    const manualInput = { date: '2020-01-01', time: '12:30', merchant: 'Lunch', amount: 12550, type: 'expense', category: 'Food & dining', bank: 'Cash' };
    const manual = addManualTransaction(manualInput);
    assert.ok(manual.id.startsWith('manual-'));
    assert.equal(db.prepare('SELECT review FROM transactions WHERE id=?').get(manual.id).review, 0);
    assert.throws(() => addManualTransaction({ ...manualInput, amount: -1 }));
    assert.throws(() => addManualTransaction({ ...manualInput, date: '2026-02-31' }));
    assert.throws(() => addManualTransaction({ ...manualInput, bank: 'Invalid' }));
    featureRequest('/api/profile', 'POST', { name: 'Test User', photo: '' });
    assert.equal(featureRequest('/api/profile', 'GET').name, 'Test User');
    const sender = featureRequest('/api/alert-senders', 'POST', { email: 'donotreply@bobcard.in' });
    assert.equal(featureRequest('/api/alert-senders', 'GET')[0].email, sender.email);
    assert.throws(() => featureRequest('/api/alert-senders', 'POST', { email: 'not-an-email' }), /valid alert sender/);
    assert.throws(() => featureRequest('/api/alert-senders', 'POST', { email: 'DONOTREPLY@BOBCARD.IN' }), /already saved/);
    const card = await featureRequest('/api/cards', 'POST', { bank: 'HDFC', variant: 'Test Card', cardholderName: 'Test User', lastFour: '1234', creditLimit: 50000000,
      rewardBalance: 1200, pointsPerUnit: 4, spendUnit: 15000, pointValue: 50, milestoneSpend: 40000000, milestoneValue: 1000000 });
    assert.equal((await featureRequest('/api/cards', 'GET'))[0].id, card.id);
    await assert.rejects(featureRequest('/api/cards', 'POST', { bank: 'HDFC', variant: 'Bad Card', cardholderName: 'Test User', lastFour: '12', creditLimit: 1,
      rewardBalance: 0, pointsPerUnit: 1, spendUnit: 100, pointValue: 1, milestoneSpend: 0, milestoneValue: 0 }), /valid card/);
    const person = featureRequest('/api/people', 'POST', { name: 'Friend' });
    assert.throws(() => featureRequest('/api/people', 'POST', { name: 'friend' }));
    db.prepare("INSERT INTO transactions (user_id,id,date,merchant,amount,type,account,category,review,note,time) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(userId(), 'test', '2026-09-09', 'Cafe', 101, 'expense', '1234', 'Food & dining', 1, '', '16:52:46');
    const input = { mode: 'equal', paidBy: 'me', participants: [{ id: 'me' }, { id: person.id }] };
    assert.throws(() => featureRequest('/api/splits/test', 'POST', input), /Confirm/);
    db.prepare('UPDATE transactions SET review=0').run();
    featureRequest('/api/splits/test', 'POST', input);
    assert.equal(listTransactions()[0].split.shares[0].amount, 51);
    assert.equal(listTransactions()[0].time, '16:52:46');
    assert.throws(() => featureRequest('/api/splits/test', 'POST', { ...input, paidBy: 'unknown' }));
    const settled = featureRequest('/api/people/' + person.id + '/settle', 'POST', {});
    assert.equal(settled.settledBalance, 50);
    assert.equal(featureRequest('/api/people', 'GET')[0].settledBalance, 50);
    db.prepare("INSERT INTO transactions (user_id,id,date,merchant,amount,type,account,category,review,note,time) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(userId(), 'test-new', '2026-09-10', 'Dinner', 200, 'expense', '1234', 'Food & dining', 0, '', '');
    featureRequest('/api/splits/test-new', 'POST', input);
    const currentPeople = featureRequest('/api/people', 'GET');
    assert.equal(balances(listTransactions(), currentPeople).get(person.id) - currentPeople[0].settledBalance, 100);
    db.close();
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const restart = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { featureRequest, listTransactions } from ${JSON.stringify(new URL('../src/features.js', import.meta.url).href)};
      import { balances } from ${JSON.stringify(new URL('../public/splits.js', import.meta.url).href)};
      import { db } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
      assert.equal(listTransactions().find(transaction => transaction.id === 'test').split.shares[0].amount, 51);
      assert.equal(featureRequest('/api/profile', 'GET').name, 'Test User');
      const senders = featureRequest('/api/alert-senders', 'GET');
      assert.equal(senders[0].email, 'donotreply@bobcard.in');
      const cards = await featureRequest('/api/cards', 'GET');
      assert.equal(cards[0].variant, 'Test Card');
      await featureRequest('/api/cards/' + cards[0].id, 'DELETE', {});
      assert.equal((await featureRequest('/api/cards', 'GET')).length, 0);
      featureRequest('/api/alert-senders/' + senders[0].id, 'DELETE', {});
      assert.equal(featureRequest('/api/alert-senders', 'GET').length, 0);
      const people = featureRequest('/api/people', 'GET');
      assert.equal(people[0].settledBalance, 50);
      assert.equal(balances(listTransactions(), people).get(people[0].id) - people[0].settledBalance, 100);
      featureRequest('/api/splits/test', 'DELETE', {});
      assert.equal(listTransactions().find(transaction => transaction.id === 'test').split, null);
      db.close();
    `], { cwd: directory, encoding: 'utf8' });
    assert.equal(restart.status, 0, restart.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
