import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('sync inserts into the real schema and skips duplicates on retry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'expense-sync-test-'));
  // Isolate generated SQLite files and credentials from the user's real database.
  const script = `
    import assert from 'node:assert/strict';
    import { sync } from ${JSON.stringify(new URL('../src/gmail.js', import.meta.url).href)};
    import { deleteTransaction } from ${JSON.stringify(new URL('../src/features.js', import.meta.url).href)};
    import { db, saveTokens, set } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
    saveTokens({ access_token: 'test', expires_at: Date.now() + 3600000 });
    globalThis.fetch = async (url) => ({ ok: true, json: async () =>
      url.includes('messages?') ? { messages: [{ id: 'test-alert' }] } : {
        internalDate: String(Date.UTC(2026, 8, 10)),
        payload: { headers: [{ name: 'From', value: 'HDFC Bank <alerts@hdfcbank.bank.in>' }],
          mimeType: 'text/plain', body: { data: Buffer.from('Rs. 757.00 has been debited from your HDFC Bank Credit Card ending 5953 towards RSP*BLINK COMMERCE PVT on 08 Sep, 2026 at 16:52:46.').toString('base64url') } }
      } });
    assert.equal((await sync()).imported, 1);
    const row = db.prepare('SELECT * FROM transactions').get();
    assert.equal(row.amount, 75700);
    assert.equal(row.date, '2026-09-08');
    assert.equal(row.merchant, 'RSP*BLINK COMMERCE PVT');
    assert.equal((await sync()).imported, 0);
    assert.equal(db.prepare('SELECT count(*) AS total FROM transactions').get().total, 1);
    assert.equal(row.review, 0);
    assert.equal(row.category, 'Groceries');
    db.prepare("UPDATE transactions SET merchant='Old parser result', review=1").run();
    set('parserVersion', '1');
    await sync();
    assert.equal(db.prepare('SELECT merchant FROM transactions').get().merchant, 'RSP*BLINK COMMERCE PVT');
    db.prepare("UPDATE transactions SET merchant='User correction', review=0").run();
    set('parserVersion', '1');
    await sync();
    assert.equal(db.prepare('SELECT merchant FROM transactions').get().merchant, 'User correction');
    deleteTransaction('test-alert');
    set('parserVersion', '1'); set('timeVersion', '0');
    assert.equal((await sync()).imported, 0);
    assert.equal(db.prepare('SELECT count(*) AS total FROM transactions').get().total, 0);
    db.close();
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
