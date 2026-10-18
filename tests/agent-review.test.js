// Regression tests from an independent review of the agent integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boot } from './helpers.js';

const iso = (ms) => new Date(ms).toISOString();

test('#3 a retried occurrence reuses its request id; a definite rejection rotates it', async () => {
  const ids = [];
  let mode = 'timeout';
  const b = await boot({ notifier: { configured: true, send: async (m, meta) => {
    ids.push(meta.request_id);
    if (mode === 'timeout') throw new Error('timeout');
    if (mode === '502') throw Object.assign(new Error('Hermes answered 502'), { definite: true });
  } } });
  try {
    await b.call('/api/tasks', { method: 'POST', body: { title: 'x', reminders: [{ at: iso(Date.now() - 1000) }] } });
    await b.app.scheduler.tick();
    await b.app.scheduler.tick(new Date(Date.now() + 3 * 60e3));
    assert.equal(ids[0], ids[1], 'unknown outcome → same id, so Hermes dedupes a delivered retry');
    mode = '502';
    await b.app.scheduler.tick(new Date(Date.now() + 10 * 60e3));
    mode = 'ok';
    await b.app.scheduler.tick(new Date(Date.now() + 30 * 60e3));
    assert.notEqual(ids[3], ids[2], 'definite rejection → new id, so the retry is not mistaken for a duplicate');
    assert.equal((await b.call('/api/tasks/1')).body.reminders[0].done, true);
  } finally { await b.close(); }
});

test('#4 one slow delivery does not serialize the whole queue', async () => {
  const b = await boot({ notifier: { configured: true, send: () => new Promise((r) => setTimeout(r, 300)) } });
  try {
    for (let i = 0; i < 6; i += 1) await b.call('/api/tasks', { method: 'POST', body: { title: `t${i}`, reminders: [{ at: iso(Date.now() - 1000) }] } });
    const started = Date.now();
    await b.app.scheduler.tick();
    assert.ok(Date.now() - started < 1500, `took ${Date.now() - started}ms`);
  } finally { await b.close(); }
});

test('#5 changing repeat while a message is in flight is not overwritten by stale bookkeeping', async () => {
  let release;
  const b = await boot({ notifier: { configured: true, send: () => new Promise((r) => { release = r; }) } });
  try {
    await b.call('/api/tasks', { method: 'POST', body: { title: 'x', reminders: [{ at: iso(Date.now() - 1000), repeat: 'daily' }] } });
    const rid = (await b.call('/api/tasks/1')).body.reminders[0].id;
    const tick = b.app.scheduler.tick();
    while (!release) await new Promise((r) => setTimeout(r, 10));
    await b.call(`/api/tasks/1/reminders/${rid}`, { method: 'PATCH', body: { repeat: 'weekly' } });
    release();
    await tick;
    const r = (await b.call('/api/tasks/1')).body.reminders[0];
    assert.equal(r.repeat, 'weekly');
    assert.equal(r.sent_count, 0, 'stale daily bookkeeping was skipped');
  } finally { await b.close(); }
});

test('#9 retries stop after a ceiling and the reminder is marked as failed', async () => {
  const b = await boot({ notifier: { configured: true, send: async () => { throw Object.assign(new Error('502'), { definite: true }); } } });
  try {
    await b.call('/api/tasks', { method: 'POST', body: { title: 'x', reminders: [{ at: iso(Date.now() - 1000) }] } });
    let t = Date.now();
    for (let i = 0; i < 10; i += 1) { t += 2 * 3600e3; await b.app.scheduler.tick(new Date(t)); }
    const r = (await b.call('/api/tasks/1')).body.reminders[0];
    assert.equal(r.done, true);
    assert.equal(r.delivery_failed, true);
    assert.match(r.last_error, /לא נמסר/);
  } finally { await b.close(); }
});

test('#6 structure changes are in the activity log and can be undone', async () => {
  const b = await boot();
  try {
    await b.call('/api/schema', { method: 'PATCH', body: { tags: ['א'] }, actor: 'agent' });
    const entry = (await b.call('/api/activity?limit=1')).body.items[0];
    assert.deepEqual([entry.action, entry.actor, entry.undoable], ['schema', 'agent', true]);
    const undone = (await b.call(`/api/activity/${entry.id}/undo`, { method: 'POST', body: {} })).body;
    assert.deepEqual(undone.schema.tags, []);
    // Undoing an older structure change after a newer one is a conflict, not a silent overwrite.
    await b.call('/api/schema', { method: 'PATCH', body: { tags: ['ב'] } });
    await b.call('/api/schema', { method: 'PATCH', body: { tags: ['ג'] } });
    const older = (await b.call('/api/activity?limit=2')).body.items[1];
    assert.equal((await b.call(`/api/activity/${older.id}/undo`, { method: 'POST', body: {} })).status, 409);
  } finally { await b.close(); }
});

test('#8 undoing an old edit of a field that changed again is a 409 conflict', async () => {
  const b = await boot();
  try {
    await b.call('/api/tasks', { method: 'POST', body: { title: 'A' } });
    await b.call('/api/tasks/1', { method: 'PATCH', body: { title: 'B' } });
    await b.call('/api/tasks/1', { method: 'PATCH', body: { title: 'C' } });
    const items = (await b.call('/api/activity')).body.items.filter((a) => a.summary === 'כותרת');
    const r = await b.call(`/api/activity/${items[1].id}/undo`, { method: 'POST', body: {} });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'conflict');
    assert.equal((await b.call('/api/tasks/1')).body.title, 'C');
  } finally { await b.close(); }
});

test('#10 a broken board.json puts structure writes in a visible degraded mode until restored', async () => {
  const b = await boot();
  try {
    await b.call('/api/schema', { method: 'PATCH', body: { tags: ['שמור'] } });
    await writeFile(join(b.root, 'data/board.json'), '{ broken');
    b.app.schemaStore.invalidate();
    const s = (await b.call('/api/schema')).body;
    assert.deepEqual(s.tags, ['שמור'], 'serves the last good structure, not defaults');
    assert.ok(s.degraded);
    const w = await b.call('/api/schema', { method: 'PATCH', body: { tags: [] } });
    assert.deepEqual([w.status, w.body.code], [503, 'schema_degraded']);
    assert.equal((await b.call('/api/schema/restore', { method: 'POST', body: {} })).status, 200);
    assert.equal((await b.call('/api/schema', { method: 'PATCH', body: { tags: [] } })).status, 200);
  } finally { await b.close(); }
});

test('#12 task id errors are consistent and machine-readable', async () => {
  const b = await boot();
  try {
    const big = await b.call('/api/tasks/999999999', { method: 'PATCH', body: { title: 'x' } });
    assert.deepEqual([big.status, big.body.code], [404, 'not_found']);
    const missing = await b.call('/api/tasks/99999');
    assert.deepEqual([missing.status, missing.body.code], [404, 'not_found']);
    const bad = await b.call('/api/tasks/1/reminders/rzzz', { method: 'DELETE' });
    assert.equal(bad.status, 404);
  } finally { await b.close(); }
});
