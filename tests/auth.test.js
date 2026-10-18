import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

test('data endpoints require a paired device or an agent token; actor comes from the credential', async () => {
  const b = await boot();
  try {
    assert.equal((await b.call('/api/tasks', { anon: true })).status, 401);
    assert.equal((await b.call('/api/events', { anon: true })).status, 401);
    assert.equal((await b.call('/api/health', { anon: true })).status, 200);
    assert.equal((await b.call('/api/tasks', { headers: { authorization: 'Bearer wrong' }, anon: true })).status, 401);
    // A paired browser can't pretend to be Hermes by sending a header.
    await b.call('/api/tasks', { method: 'POST', body: { title: 'x' }, headers: { 'x-actor': 'agent' } });
    await b.call('/api/tasks', { method: 'POST', body: { title: 'y' }, actor: 'agent' });
    const actors = (await b.call('/api/activity')).body.items.map((a) => a.actor);
    assert.deepEqual(actors, ['agent', 'dashboard']);
  } finally { await b.close(); }
});

test('pairing: code goes to WhatsApp, is single-use, throttled, and yields a working cookie', async () => {
  const b = await boot();
  try {
    const r = await b.call('/api/auth/request-code', { method: 'POST', body: {}, anon: true, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' } });
    assert.equal(r.body.sent, true);
    const code = b.sent.at(-1).message.match(/(\d{6})/)[1];
    assert.match(b.sent.at(-1).message, /iPhone/);
    assert.equal((await b.call('/api/auth/request-code', { method: 'POST', body: {}, anon: true })).status, 429);
    assert.equal((await b.call('/api/auth/verify', { method: 'POST', body: { code: '999999' }, anon: true })).status, 400);
    const ok = await fetch(`${b.base}/api/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    const token = cookie.match(/wb_session=([^;]+)/)[1];
    assert.equal((await b.call('/api/tasks', { anon: true, headers: { cookie: `wb_session=${token}` } })).status, 200);
    assert.equal((await b.call('/api/auth/verify', { method: 'POST', body: { code }, anon: true })).status, 400, 'code is single-use');
    // Revoking a device locks it out.
    const sessions = (await b.call('/api/sessions')).body.items;
    const phone = sessions.find((s) => s.device.startsWith('iPhone'));
    await b.call(`/api/sessions/${phone.id}`, { method: 'DELETE' });
    assert.equal((await b.call('/api/tasks', { anon: true, headers: { cookie: `wb_session=${token}` } })).status, 401);
  } finally { await b.close(); }
});

test('test notification sends fixed text only and is rate-limited', async () => {
  const b = await boot();
  try {
    await b.call('/api/notifications/test', { method: 'POST', body: { message: 'הודעה שרירותית' } });
    assert.match(b.sent.at(-1).message, /Workboard מחובר/);
    assert.equal((await b.call('/api/notifications/test', { method: 'POST', body: {} })).status, 429);
  } finally { await b.close(); }
});
