import test from 'node:test';
import assert from 'node:assert/strict';
import { gmailError } from '../src/google-errors.js';

test('distinguishes different Google 403 causes', () => {
  assert.match(gmailError(403, { error: { details: [{ reason: 'SERVICE_DISABLED' }] } }), /Enable Gmail API/);
  assert.match(gmailError(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }), /Reconnect Gmail/);
  assert.match(gmailError(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }), /Wait and retry/);
  assert.match(gmailError(403, { error: { errors: [{ reason: 'domainPolicy' }] } }), /administrator/);
  assert.match(gmailError(403, { error: { message: 'Specific Google explanation' } }), /Specific Google explanation/);
});
