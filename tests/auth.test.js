import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('sessions resolve separate users and data stays isolated by request context', () => {
  const directory = mkdtempSync(join(tmpdir(), 'expense-auth-test-'));
  const script = `
    import assert from 'node:assert/strict';
    import { db, withUser, findOrCreateUser, createSession, sessionUser, deleteSession, set, get } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
    const first = findOrCreateUser('first@example.com');
    const second = findOrCreateUser('second@example.com');
    assert.notEqual(first, second);
    const session = createSession(first);
    assert.equal(sessionUser(session), first);
    withUser(first, () => set('profileName', 'First'));
    withUser(second, () => set('profileName', 'Second'));
    assert.equal(withUser(first, () => get('profileName')), 'First');
    assert.equal(withUser(second, () => get('profileName')), 'Second');
    deleteSession(session);
    assert.equal(sessionUser(session), null);
    db.close();
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});