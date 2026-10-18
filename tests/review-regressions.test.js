// Regression tests from a code review: each test reproduces a bug that was fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';
import { boot } from './helpers.js';
import { nextOccurrence } from '../server/time.js';

const iso = (ms) => new Date(ms).toISOString();

test('parallel agent writes are serialized — nothing is lost', async () => {
  const b = await boot();
  try {
    await b.call('/api/tasks', { method: 'POST', body: { title: 'מקביל' } });
    await Promise.all(Array.from({ length: 10 }, (_, i) => b.call('/api/tasks/1/steps', { method: 'POST', body: { text: `שלב ${i}` }, actor: 'agent' })));
    await Promise.all(Array.from({ length: 6 }, (_, i) => b.call('/api/tasks/1/reminders', { method: 'POST', body: { at: iso(Date.now() + (i + 1) * 3600e3) }, actor: 'agent' })));
    const t = (await b.call('/api/tasks/1')).body;
    assert.equal(t.steps.length, 10);
    assert.equal(t.reminders.length, 6);
  } finally { await b.close(); }
});

test('a malformed reminder neither spams nor blocks the other reminders', async () => {
  const b = await boot();
  try {
    await b.call('/api/tasks', { method: 'POST', body: { title: 'שבור' } });
    await b.call('/api/tasks', { method: 'POST', body: { title: 'תקין', reminders: [{ at: iso(Date.now() - 1000) }] } });
    const path = join(b.root, 'data/tasks/1.md');
    const md = await readFile(path, 'utf8');
    await writeFile(path, md.replace('reminders: []', 'reminders: [{"id":"rbad","at":"tomorrow 9am","repeat":"daily","done":false}]'));
    await b.app.scheduler.tick();
    await b.app.scheduler.tick();
    assert.deepEqual(b.sent.map((x) => x.meta.task), ['2']);
    const bad = (await b.call('/api/tasks/1')).body.reminders[0];
    assert.equal(bad.done, true);
    assert.match(bad.last_error, /זמן לא תקין/);
  } finally { await b.close(); }
});

test('removing a status/project still in use is refused; hand-orphaned tasks stay editable', async () => {
  const b = await boot();
  try {
    await b.call('/api/schema', { method: 'PATCH', body: { projects: [{ id: 'p1', name: 'א' }] } });
    await b.call('/api/tasks', { method: 'POST', body: { title: 'x', project: 'p1', status: 'waiting' } });
    const r1 = await b.call('/api/schema', { method: 'PATCH', body: { projects: [] } });
    assert.equal(r1.status, 400);
    assert.match(r1.body.error, /archived/);
    const schema = (await b.call('/api/schema')).body;
    const r2 = await b.call('/api/schema', { method: 'PUT', body: { ...schema, statuses: schema.statuses.filter((s) => s.id !== 'waiting') } });
    assert.equal(r2.status, 400);
    // A task whose status was removed by hand-editing the file is still editable.
    const path = join(b.root, 'data/tasks/1.md');
    await writeFile(path, (await readFile(path, 'utf8')).replace('status: "waiting"', 'status: "ghost"'));
    const upd = await b.call('/api/tasks/1', { method: 'PATCH', body: { notes: 'עדיין עובד' } });
    assert.equal(upd.status, 200);
    assert.equal((await b.call('/api/tasks/1', { method: 'PATCH', body: { status: 'ghost2' } })).status, 400);
  } finally { await b.close(); }
});

test('undoing an older change keeps later edits, and the undo can itself be undone', async () => {
  const b = await boot();
  try {
    await b.call('/api/tasks', { method: 'POST', body: { title: 'מקור' } });
    await b.call('/api/tasks/1', { method: 'PATCH', body: { title: 'שונה ע״י הסוכן' }, actor: 'agent' });
    await b.call('/api/tasks/1', { method: 'PATCH', body: { priority: 'high', notes: 'הערה חשובה' } });
    const titleEntry = (await b.call('/api/activity')).body.items.find((a) => a.summary === 'כותרת');
    let t = (await b.call(`/api/activity/${titleEntry.id}/undo`, { method: 'POST', body: {} })).body;
    assert.deepEqual([t.title, t.priority, t.notes], ['מקור', 'high', 'הערה חשובה']);
    const undoEntry = (await b.call('/api/activity?limit=1')).body.items[0];
    assert.equal(undoEntry.undoable, true);
    t = (await b.call(`/api/activity/${undoEntry.id}/undo`, { method: 'POST', body: {} })).body;
    assert.equal(t.title, 'שונה ע״י הסוכן');
  } finally { await b.close(); }
});

test('editing a fired reminder does not re-arm it; snooze during delivery is not overwritten', async () => {
  const b = await boot();
  try {
    await b.call('/api/tasks', { method: 'POST', body: { title: 'x', reminders: [{ at: iso(Date.now() - 1000) }] } });
    await b.app.scheduler.tick();
    const rid = (await b.call('/api/tasks/1')).body.reminders[0].id;
    const edited = (await b.call(`/api/tasks/1/reminders/${rid}`, { method: 'PATCH', body: { note: 'עריכה' } })).body.reminders[0];
    assert.equal(edited.done, true);
    await b.app.scheduler.tick();
    assert.equal(b.sent.length, 1);

    // Compare-and-set: the scheduler's bookkeeping is skipped if the reminder moved meanwhile.
    const snoozed = (await b.call(`/api/tasks/1/reminders/${rid}/snooze`, { method: 'POST', body: { minutes: 30 } })).body.reminders[0];
    const stale = { at: edited.at, done: false };
    assert.equal(await b.app.taskStore.markReminder('1', rid, { done: true }, stale), null);
    assert.equal((await b.call('/api/tasks/1')).body.reminders[0].at, snoozed.at);
  } finally { await b.close(); }
});

test('reminder API edge cases: returns the new reminder, rejects date-only and nag+repeat', async () => {
  const b = await boot();
  try {
    await b.call('/api/tasks', { method: 'POST', body: { title: 'x' } });
    const r = await b.call('/api/tasks/1/reminders', { method: 'POST', body: { at: '2030-01-05T09:00' }, actor: 'agent' });
    assert.equal(r.status, 201);
    assert.match(r.body.reminder.id, /^r/);
    assert.equal(r.body.reminder.anchor, '2030-01-05T09:00');
    assert.equal((await b.call('/api/tasks/1/reminders', { method: 'POST', body: { at: '2030-01-05' } })).status, 400);
    assert.equal((await b.call('/api/tasks/1/reminders', { method: 'POST', body: { at: '2030-01-05T09:00', nag: 30, repeat: 'daily' } })).status, 400);
  } finally { await b.close(); }
});

test('monthly reminders keep their day; daily keeps 02:30 across the DST gap', () => {
  let at = '2026-01-31T07:00:00.000Z'; // 09:00 local
  const anchor = '2026-01-31T09:00';
  const days = [];
  for (let i = 0; i < 3; i += 1) { at = nextOccurrence(at, 'monthly', new Date(Date.parse(at) + 1000), anchor); days.push(at.slice(0, 10)); }
  assert.deepEqual(days, ['2026-02-28', '2026-03-31', '2026-04-30']);
  // Israel springs forward on 2027-03-26 (02:00 → 03:00): 02:30 that day doesn't exist, the next day it's 02:30 again.
  let d = '2027-03-25T00:30:00.000Z';
  for (let i = 0; i < 2; i += 1) d = nextOccurrence(d, 'daily', new Date(Date.parse(d) + 1000), '2027-03-25T02:30');
  assert.equal(d, '2027-03-26T23:30:00.000Z'); // 02:30 IDT on the 27th
});

test('schema writes are versioned (409 on stale rev) and a broken board.json is backed up', async () => {
  const b = await boot();
  try {
    const s0 = (await b.call('/api/schema')).body;
    await b.call('/api/schema', { method: 'PATCH', body: { tags: ['א'] }, actor: 'agent' });
    const stale = await b.call('/api/schema', { method: 'PUT', body: { ...s0, title: 'ישן' } });
    assert.equal(stale.status, 409);
    await writeFile(join(b.root, 'data/board.json'), '{ broken');
    b.app.schemaStore.invalidate();
    assert.equal((await b.call('/api/schema')).status, 200);
    assert.ok((await readdir(join(b.root, 'data'))).some((n) => n.startsWith('board.json.broken-')));
  } finally { await b.close(); }
});

test('request guards: unknown Host, writes without JSON/X-Actor, bad paths', async () => {
  const b = await boot();
  try {
    const { port } = new URL(b.base);
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/tasks', headers: { host: `evil.example:${port}` } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(status, 421);
    assert.equal((await fetch(`${b.base}/api/notifications/test`, { method: 'POST' })).status, 415);
    assert.equal((await fetch(`${b.base}/api/tasks`, { method: 'POST', headers: { 'x-actor': 'agent' } })).status, 415); // a header alone is not a credential
    assert.equal((await fetch(`${b.base}/api/tasks`, { method: 'POST', headers: { authorization: 'Bearer test-hermes-token' } })).status, 400); // token passes the guard, fails validation
    assert.equal((await fetch(`${b.base}/%E0%A4%A`)).status, 400);
    await b.call('/api/schema', { method: 'PATCH', body: { fields: [{ id: 'link', label: 'קישור', type: 'url' }] } });
    await b.call('/api/tasks', { method: 'POST', body: { title: 'x' } });
    assert.equal((await b.call('/api/tasks/1', { method: 'PATCH', body: { fields: { link: 'javascript:alert(1)' } } })).status, 400);
  } finally { await b.close(); }
});
