export function gmailError(status, payload = {}) {
  const error = payload.error || {};
  const reasons = [...(error.errors || []), ...(error.details || [])].map(item => item.reason || '').join(' ');
  const detail = String(error.message || '').slice(0, 600);
  const evidence = `${reasons} ${detail}`;
  if (status === 401) return 'Gmail access expired. Click Reconnect Gmail.';
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/i.test(evidence)) {
    return 'Gmail API is disabled or not enabled for your OAuth project. Enable Gmail API in Google Cloud → APIs & Services → Library, then retry.';
  }
  if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient.*scope/i.test(evidence)) {
    return 'Gmail read permission is missing. Click Reconnect Gmail and approve read access.';
  }
  if (/rateLimit|quota|dailyLimit|RESOURCE_EXHAUSTED/i.test(evidence) || status === 429) {
    return 'Google has limited Gmail requests. Wait and retry; if this persists, check Gmail API quotas in Google Cloud.';
  }
  if (/domainPolicy/i.test(evidence)) return 'Your Google organization policy blocks Gmail API access. Contact its administrator.';
  return `Gmail request failed (${status}). ${detail || reasons || 'Google did not provide a reason. Check Gmail API access in your OAuth project.'}`;
}
