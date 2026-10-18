// Regressions for the defects Hermes reproduced in its 2026-10-11 reliability review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';
import { createNotifier } from '../server/notifier.js';

const post = (body = {}) => ({ method: 'POST', body });
const patch = (body) => ({ method: 'PATCH', body });
const latest = async (b) => (await b.call('/api/activity?limit=1')).body.items[0];

test('a revoked device stops receiving live task data on its open stream', async () => {
  const b = await boot();
  const other = await b.app.auth.createSessionForTests('other');
  const ctrl = new AbortController();
  try {
    const victim = (await b.call('/api/sessions')).body.items.find((s) => s.current);
    const res = await fetch(`${b.base}/api/events`, { headers: { cookie: `wb_session=${b.session}` }, signal: ctrl.signal });
    const reader = res.body.getReader();
    await reader.read(); // hello
    await b.call('/api/tasks', post({ title: 'x' }));
    const revoke = await fetch(`${b.base}/api/sessions/${victim.id}`, { method: 'DELETE', headers: { cookie: `wb_session=${other}`, 'content-type': 'application/json' } });
    assert.equal(revoke.status, 200);
    await fetch(`${b.base}/api/tasks/1`, { method: 'PATCH', headers: { cookie: `wb_session=${other}`, 'content-type': 'application/json' }, body: JSON.stringify({ notes: 'SECRET AFTER REVOCATION' }) });
    let text = '';
    const deadline = Date.now() + 1500;
    try {
      while (Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ timeout: true }), 300))]);
        if (chunk.timeout) continue;
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
    } catch { /* stream destroyed — expected */ }
    assert.doesNotMatch(text, /SECRET AFTER REVOCATION/);
  } finally { ctrl.abort(); await b.close(); }
});

test('a note-only edit keeps reminder retry identity after a definite rejection', async () => {
  const ids = []; const seen = new Set(); let delivered = 0;
  const notifier = createNotifier({ url: 'http://fake.invalid/workboard', secret: 'test', fetchImpl: async (_u, init) => {
    const id = init.headers['x-request-id']; ids.push(id);
    if (seen.has(id)) return new Response('{"status":"duplicate"}');
    seen.add(id);
    if (ids.length === 1) return new Response('delivery rejected', { status: 502 });
    delivered += 1; return new Response('{"status":"delivered"}');
  } });
  const b = await boot({ notifier });
  try {
    const t0 = new Date('2030-01-06T08:00:00Z');
    await b.call('/api/tasks', post({ title: 'retry', reminders: [{ id: 'rx', at: t0.toISOString() }] }));
    await b.app.scheduler.tick(t0);
    assert.equal((await b.call('/api/tasks/1')).body.reminders[0].fail_seq, 1);
    await b.call('/api/tasks/1/reminders/rx', patch({ note: 'note only' }));
    assert.equal((await b.call('/api/tasks/1')).body.reminders[0].fail_seq, 1, 'bookkeeping survives the edit');
    await b.app.scheduler.tick(new Date('2030-01-06T08:03:00Z'));
    assert.notEqual(ids[1], ids[0], 'a definite rejection gets a fresh request id');
    assert.equal(delivered, 1);
    const r = (await b.call('/api/tasks/1')).body.reminders[0];
    assert.equal(r.done, true); assert.equal(r.sent_count, 1);
  } finally { await b.close(); }
});

test('a reminder snoozed while queued behind slow deliveries is not sent at its old time', async () => {
  const started = Promise.withResolvers(); const release = Promise.withResolvers();
  const sent = []; let inFlight = 0;
  const b = await boot({ notifier: { configured: true, send: async (_m, meta) => {
    sent.push(meta.task);
    if (meta.task !== '4') { inFlight += 1; if (inFlight === 3) started.resolve(); await release.promise; }
  } } });
  let tick;
  try {
    const t0 = new Date('2030-01-06T08:00:00Z');
    for (let n = 1; n <= 5; n += 1) await b.call('/api/tasks', post({ title: `q${n}`, reminders: [{ id: 'rq', at: t0.toISOString() }] }));
    tick = b.app.scheduler.tick(t0);
    await started.promise;
    await b.call('/api/tasks/4/reminders/rq/snooze', post({ at: '2030-01-06T09:00:00.000Z' }));
    await b.call('/api/tasks/5', patch({ status: 'done' }));
    release.resolve(); await tick;
    assert.deepEqual(sent, ['1', '2', '3']);
    const r4 = (await b.call('/api/tasks/4')).body.reminders[0];
    assert.equal(r4.done, false); assert.equal(r4.sent_count, 0);
    await b.app.scheduler.tick(new Date('2030-01-06T09:00:30Z'));
    assert.deepEqual(sent, ['1', '2', '3', '4'], 'and it does go out at the new time');
  } finally { release.resolve(); if (tick) await tick; await b.close(); }
});

test('structure undo unwinds consecutive changes in reverse order; out-of-order undo still conflicts', async () => {
  const b = await boot();
  try {
    const original = (await b.call('/api/schema')).body;
    await b.call('/api/schema', patch({ title: 'A' }));
    const first = await latest(b);
    await b.call('/api/schema', patch({ tags: ['t1'] }));
    const second = await latest(b);
    assert.equal((await b.call(`/api/activity/${first.id}/undo`, post())).status, 409, 'cannot skip the later change');
    assert.equal((await b.call(`/api/activity/${second.id}/undo`, post())).status, 200);
    const undoFirst = await b.call(`/api/activity/${first.id}/undo`, post());
    assert.equal(undoFirst.status, 200);
    const final = (await b.call('/api/schema')).body;
    assert.equal(final.title, original.title);
    assert.deepEqual(final.tags, original.tags);
    assert.ok(final.rev > original.rev + 3, 'rev keeps increasing');
  } finally { await b.close(); }
});
