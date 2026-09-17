export function createApi(fetchRequest = (...args) => fetch(...args)) {
  let csrf = '';
  async function api(path, method = 'GET', data, retried = false) {
    const response = await fetchRequest(path, { method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      ...(data ? { body: JSON.stringify(data) } : {}) });
    const result = await response.json();
    // Only retry a token rejection: the server rejected it before any mutation ran.
    if (response.status === 403 && result.code === 'CSRF_EXPIRED' && method !== 'GET' && !retried) {
      await api('/api/status');
      return api(path, method, data, true);
    }
    if (!response.ok) throw new Error(result.error || 'Request failed.');
    if (path === '/api/status') csrf = result.csrf;
    return result;
  }
  return api;
}
