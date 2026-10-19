// Offline snapshot = read-only: block writes centrally instead of letting them fail one by one.
let readOnly = false;
export const setReadOnly = (value) => { readOnly = value; };

async function request(path, { method = 'GET', body } = {}) {
  if (readOnly && method !== 'GET' && !path.startsWith('/api/auth/')) throw Object.assign(new Error('אין חיבור — התצוגה לקריאה בלבד, השינוי לא נשמר'), { status: 0, offline: true });
  // Every write carries a JSON content type — the server rejects writes without it (CSRF guard).
  const response = await fetch(path, { method, headers: method !== 'GET' ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  // Device was revoked (or never paired): show the pairing screen.
  if (response.status === 401 && !path.startsWith('/api/auth/')) document.dispatchEvent(new Event('wb:unauthorized'));
  if (!response.ok) throw Object.assign(new Error(data.error || `שגיאה ${response.status}`), { status: response.status });
  return data;
}

export const api = {
  bootstrap: () => request('/api/bootstrap'),
  version: () => request('/api/version'),
  schedule: (from) => request(`/api/schedule${from ? `?from=${from}` : ''}`),
  addEvent: (e) => request('/api/schedule', { method: 'POST', body: e }),
  updateEvent: (id, changes) => request(`/api/schedule/${id}`, { method: 'PATCH', body: changes }),
  removeEvent: (id) => request(`/api/schedule/${id}`, { method: 'DELETE' }),
  create: (task) => request('/api/tasks', { method: 'POST', body: task }),
  get: (id) => request(`/api/tasks/${id}`),
  update: (id, changes) => request(`/api/tasks/${id}`, { method: 'PATCH', body: changes }),
  remove: (id) => request(`/api/tasks/${id}`, { method: 'DELETE' }),
  addReminder: (id, reminder) => request(`/api/tasks/${id}/reminders`, { method: 'POST', body: reminder }),
  removeReminder: (id, rid) => request(`/api/tasks/${id}/reminders/${rid}`, { method: 'DELETE' }),
  snooze: (id, rid, body) => request(`/api/tasks/${id}/reminders/${rid}/snooze`, { method: 'POST', body }),
  activity: (task, limit = 40) => request(`/api/activity?limit=${limit}${task ? `&task=${task}` : ''}`),
  undo: (activityId) => request(`/api/activity/${activityId}/undo`, { method: 'POST', body: {} }),
  schema: (schema) => request('/api/schema', { method: 'PUT', body: schema }),
  getSchema: () => request('/api/schema'),
  patchSchema: (changes) => request('/api/schema', { method: 'PATCH', body: changes }),
  notifications: () => request('/api/notifications?limit=15'),
  testNotification: () => request('/api/notifications/test', { method: 'POST', body: {} }),
  authStatus: () => request('/api/auth/status'),
  requestCode: (user) => request('/api/auth/request-code', { method: 'POST', body: { user } }),
  verifyCode: (code, user) => request('/api/auth/verify', { method: 'POST', body: { code, user } }),
  shopping: () => request('/api/shopping'),
  addShopping: (items) => request('/api/shopping', { method: 'POST', body: { items } }),
  updateShopping: (id, changes) => request(`/api/shopping/${id}`, { method: 'PATCH', body: changes }),
  removeShopping: (id) => request(`/api/shopping/${id}`, { method: 'DELETE' }),
  finishShopping: (list) => request('/api/shopping/finish', { method: 'POST', body: { list } }),
  claimShopping: (id, claimed) => request(`/api/shopping/${id}/claim`, { method: 'POST', body: { claimed } }),
  restoreShopping: (items) => request('/api/shopping/restore', { method: 'POST', body: { items } }),
  sessions: () => request('/api/sessions'),
  revokeSession: (id) => request(`/api/sessions/${id}`, { method: 'DELETE' }),
  restoreSchema: () => request('/api/schema/restore', { method: 'POST', body: {} }),
  exposeToOrg: (id) => request(`/api/tasks/${id}/org`, { method: 'POST', body: {} }),
  orgStatus: () => request('/api/org'),
  orgSync: () => request('/api/org/sync', { method: 'POST', body: {} }),
};

/** Live updates (agent edits, reminders firing) over Server-Sent Events; reconnects automatically. */
export function connectEvents(onEvent, onStatus) {
  let source;
  const open = () => {
    source = new EventSource('/api/events');
    source.onopen = () => onStatus(true);
    source.onerror = () => onStatus(false);
    source.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch { /* ignore */ } };
  };
  open();
  return () => source.close();
}
