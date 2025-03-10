import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('HDFC statement lookup uses the documented passwords and a matching PDF attachment', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hdfc-statement-test-'));
  const script = `
    import assert from 'node:assert/strict';
    import { findHdfcCardStatement, hdfcStatementPassword } from ${JSON.stringify(new URL('../src/gmail.js', import.meta.url).href)};
    import { db, saveTokens } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
    saveTokens({ access_token: 'test', expires_at: Date.now() + 3600000 });
    assert.equal(hdfcStatementPassword('Ravi Shankar', '5678'), 'RAVI5678');
    assert.equal(hdfcStatementPassword('Ravi Shankar', '5678', '0512'), 'RAVI0512');
    assert.throws(() => hdfcStatementPassword('Ravi', '5678', '3213'), /DDMM/);
    let fetches = 0;
    globalThis.fetch = async url => {
      fetches++;
      if (fetches === 1) throw new TypeError('fetch failed');
      return { ok: true, json: async () => {
      if (url.includes('messages?')) return { messages: [{ id: 'statement-message' }] };
      if (url.includes('/attachments/')) return { data: Buffer.from('%PDF-synthetic').toString('base64url') };
      return { payload: { headers: [
        { name: 'From', value: 'HDFC Bank <Emailstatements.cards@hdfcbank.bank.in>' },
        { name: 'Subject', value: 'Credit card statement ending 5678' }
      ], mimeType: 'multipart/mixed', parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('Your monthly statement').toString('base64url') } },
        { filename: 'HDFC-5678.pdf', mimeType: 'application/pdf', body: { attachmentId: 'attachment-1' } }
      ] } };
    } };
    };
    const statement = await findHdfcCardStatement('5678');
    assert.equal(statement.name, 'HDFC-5678.pdf');
    assert.equal(Buffer.from(statement.data, 'base64').toString(), '%PDF-synthetic');
    assert.equal(fetches, 4);
    db.close();
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
