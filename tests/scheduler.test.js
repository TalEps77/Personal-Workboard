import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { boot } from './helpers.js';
import { createNotifier } from '../server/notifier.js';
import { inQuietHours, nextOccurrence } from '../server/time.js';

const iso = (s) => new Date(s).toISOString();

test('a due reminder is sent once with task context, then marked done', async () => {
  const b = await boot();
  try {
    await b.call('/api/tasks', { method: 'POST', body: { title: 'להתקשר לאבי', steps: ['לחייג', 'לסכם'], reminders: [{ at: iso(Date.now() - 1000), note: 'לפני 12' }] } });
    await b.app.scheduler.tick();
    await b.app.scheduler.tick();
    assert.equal(b.sent.length, 1);
    assert.match(b.sent[0].message, /תזכורת.*#1/);
    assert.match(b.sent[0].message, /להתקשר לאבי/);
    assert.match(b.sent[0].message, /שלבים 0\/2 — הבא: לחייג/);
    const r = (await b.call('/api/tasks/1')).body.reminders[0];
    assert.deepEqual([r.done, r.sent_count], [true, 1]);
  } finally { await b.close(); }
});

test('future reminders wait; done tasks never nag; failures retry later and are visible', async () => {
  let fail = true;
  const sent = [];
  const b = await boot({ notifier: { configured: true, send: async (m) => { if (fail) throw new Error('hermes down'); sent.push(m); } } });
  try {
    await b.call('/api/tasks', { method: 'POST', body: { title: 'עתידי', reminders: [{ at: iso(Date.now() + 3600e3) }] } });
    await b.call('/api/tasks', { method: 'POST', body: { title: 'נדנוד', reminders: [{ at: iso(Date.now() - 1000), nag: 30 }] } });
    await b.app.scheduler.tick();
    let nag = (await b.call('/api/tasks/2')).body.reminders[0];
    assert.equal(nag.last_error, 'hermes down');
    assert.ok(Date.parse(nag.retry_at) > Date.now());
    fail = false;
    await b.app.scheduler.tick(new Date(Date.now() + 3 * 60e3));
    nag = (await b.call('/api/tasks/2')).body.reminders[0];
    assert.equal(sent.length, 1);
    assert.equal(nag.done, false, 'nag stays active until the task is done');
    assert.ok(Date.parse(nag.at) > Date.now() + 25 * 60e3);
    await b.call('/api/tasks/2', { method: 'PATCH', body: { status: 'done' } });
    await b.app.scheduler.tick(new Date(Date.now() + 40 * 60e3));
    assert.equal(sent.length, 1, 'no nag after done');
    assert.equal((await b.call('/api/tasks/2')).body.reminders[0].done, true);
  } finally { await b.close(); }
});

test('snooze re-arms a reminder that already fired', async () => {
  const b = await boot();
  try {
    await b.call('/api/tasks', { method: 'POST', body: { title: 'x', reminders: [{ at: iso(Date.now() - 1000) }] } });
    await b.app.scheduler.tick();
    const rid = (await b.call('/api/tasks/1')).body.reminders[0].id;
    const t = (await b.call(`/api/tasks/1/reminders/${rid}/snooze`, { method: 'POST', body: { minutes: 60 }, actor: 'agent' })).body;
    assert.equal(t.reminders[0].done, false);
    await b.app.scheduler.tick(new Date(Date.now() + 61 * 60e3));
    assert.equal(b.sent.length, 2);
  } finally { await b.close(); }
});

test('morning digest is sent once per day when enabled', async () => {
  const b = await boot();
  try {
    await b.call('/api/schema', { method: 'PATCH', body: { notifications: { enabled: true, quietHours: { start: '22:00', end: '07:30' }, digest: { enabled: true, time: '08:00', days: [0, 1, 2, 3, 4, 5, 6] } } } });
    await b.call('/api/tasks', { method: 'POST', body: { title: 'בעבודה', status: 'doing' } });
    const morning = new Date('2026-10-11T05:30:00Z'); // 08:30 Israel
    await b.app.scheduler.tick(morning);
    await b.app.scheduler.tick(new Date(morning.getTime() + 60e3));
    assert.equal(b.sent.length, 1);
    assert.match(b.sent[0].message, /בוקר טוב/);
    assert.match(b.sent[0].message, /בעבודה/);
  } finally { await b.close(); }
});

test('notifier signs the body exactly like Hermes expects', async () => {
  let captured;
  const n = createNotifier({ url: 'http://hermes/webhooks/workboard', secret: 's3cret', fetchImpl: async (url, init) => { captured = init; return new Response('{"status":"delivered"}'); } });
  await n.send('שלום', { event_type: 'workboard.test' });
  assert.equal(captured.headers['x-webhook-signature'], createHmac('sha256', 's3cret').update(captured.body).digest('hex'));
  assert.equal(JSON.parse(captured.body).message, 'שלום');
});

test('time helpers: Israel DST, work-week repeats, quiet hours across midnight', () => {
  // weekdays repeat from Thursday 09:00 skips Fri/Sat → Sunday 09:00 local
  assert.equal(nextOccurrence('2026-10-08T06:00:00Z', 'weekdays', new Date('2026-10-08T07:00:00Z')), '2026-10-11T06:00:00.000Z');
  // daily across the DST change (Oct 25 2026): stays 09:00 local → 07:00Z in winter
  assert.equal(nextOccurrence('2026-10-24T06:00:00Z', 'daily', new Date('2026-10-24T07:00:00Z')), '2026-10-25T07:00:00.000Z');
  assert.equal(nextOccurrence('2026-01-31T07:00:00Z', 'monthly', new Date('2026-01-31T08:00:00Z')).slice(0, 10), '2026-02-28');
  const q = { start: '22:00', end: '07:30' };
  assert.equal(inQuietHours(q, new Date('2026-10-09T20:30:00Z')), true); // 23:30 local
  assert.equal(inQuietHours(q, new Date('2026-10-09T03:00:00Z')), true); // 06:00 local
  assert.equal(inQuietHours(q, new Date('2026-10-09T09:00:00Z')), false); // 12:00 local
});
