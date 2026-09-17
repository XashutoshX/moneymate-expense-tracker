import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('profile, people and splits persist in SQLite and pending splits are rejected', () => {
  const directory = mkdtempSync(join(tmpdir(), 'expense-feature-test-'));
  const script = `
    import assert from 'node:assert/strict';
    import { featureRequest, listTransactions } from ${JSON.stringify(new URL('../src/features.js', import.meta.url).href)};
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
    db.close();
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const restart = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { featureRequest, listTransactions } from ${JSON.stringify(new URL('../src/features.js', import.meta.url).href)};
      import { db } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
      assert.equal(listTransactions()[0].split.shares[0].amount, 51);
      assert.equal(featureRequest('/api/profile', 'GET').name, 'Test User');
      featureRequest('/api/splits/test', 'DELETE', {});
      assert.equal(listTransactions()[0].split, null);
      db.close();
    `], { cwd: directory, encoding: 'utf8' });
    assert.equal(restart.status, 0, restart.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
