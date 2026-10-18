import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, AGENT_TOKEN } from './helpers.js';
import { freeGaps, normalizeEvent, remindMs } from '../server/events.js';
import { addDays, today } from '../server/time.js';

const tool = async (b, name, args) => {
  const res = await fetch(`${b.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const body = await res.json();
  return { text: body.result.content[0].text, error: body.result.isError === true };
};

test('event validation and reminder time', () => {
  assert.throws(() => normalizeEvent({ title: 'x', date: '2026-02-30', start: '10:00' }), /real/);
  assert.throws(() => normalizeEvent({ title: 'x', date: '2026-10-14', start: '10:00', end: '09:00' }), /after start/);
  const e = normalizeEvent({ title: 'דיון', date: '2026-10-14', start: '9:30', kind: 'meeting' });
  assert.equal(e.start, '09:30');
  assert.equal(new Date(remindMs(e)).toISOString(), '2026-10-14T06:15:00.000Z', 'meeting default: 15 min before (Israel time)');
  assert.equal(remindMs({ ...e, remind: -1 }), null);
  assert.deepEqual(freeGaps([{ date: '2026-10-14', start: '09:00', end: '10:00' }, { date: '2026-10-14', start: '11:00', end: '11:15' }], '2026-10-14', { now: new Date('2026-10-13T12:00:00Z') }), ['08:00–09:00', '10:00–11:00', '11:15–18:00']);
});

// Uses the next workday, not "tomorrow": free gaps are only computed on workdays (the test failed on Thursdays).
test('schedule via tools: add with Hebrew times, overlap warning, calendar with free gaps, move, cancel + undo', async () => {
  const b = await boot();
  try {
    await b.call('/api/tasks', { method: 'POST', body: { title: 'מסמך אפיון' } });
    let r = await tool(b, 'add_events', { events: [
      { at: 'next-workday 11:00', minutes: 30, kind: 'work', task: 1, remind_before: 10 },
      { title: 'דיון תקציב', at: 'next-workday 11:15', end: '12:00', with: 'הספק' },
      { title: 'שבור', at: 'next-workday 25:00' },
    ] });
    assert.match(r.text, /✅ .* 11:00–11:30 · מסמך אפיון · זמן עבודה · #1 · ⏰ 10 דק׳ לפני/);
    assert.match(r.text, /✅ .*11:15–12:00 · דיון תקציב · דיון \/ פגישה · עם: הספק · ⏰ 15 דק׳ לפני.*⚠️ חופף ל: 11:00 מסמך/);
    assert.match(r.text, /❌ פריט 3/);
    r = await tool(b, 'calendar', { from: 'next-workday', days: 1 });
    assert.match(r.text, /11:00–11:30 · מסמך אפיון/);
    assert.match(r.text, /פנוי: 08:00–11:00, 12:00–18:00/);
    const id = r.text.match(/דיון תקציב.*\[(e\w+)\]/)[1];
    r = await tool(b, 'update_events', { updates: [{ id, at: 'next-workday 14:30' }] });
    assert.match(r.text, /✅ .*14:30–15:15 · דיון תקציב/, 'moving keeps the length');
    assert.doesNotMatch(r.text, /חופף/);
    r = await tool(b, 'update_events', { updates: [{ id, cancel: true }] });
    const undoId = r.text.match(/undo: (a\w+)/)[1];
    assert.equal((await b.call('/api/schedule')).body.items.length, 1);
    r = await tool(b, 'undo', { activity_id: undoId });
    assert.equal((await b.call('/api/schedule')).body.items.length, 2, 'cancel is undoable');
    r = await tool(b, 'board', {});
    assert.ok(!/הלו״ז היום/.test(r.text) || r.text.includes('לו״ז'), 'board mentions the schedule only for today');
  } finally { await b.close(); }
});

test('the scheduler sends a heads-up before each item, once; a moved item is reminded again', async () => {
  const b = await boot();
  try {
    await b.call('/api/tasks', { method: 'POST', body: { title: 'מצגת', steps: ['שלד', 'טיוטה'] } });
    const d = addDays(today(), 1);
    const e = (await b.call('/api/schedule', { method: 'POST', body: { title: 'עע מצגת', date: d, start: '13:00', end: '13:45', kind: 'work', task: '1' } })).body;
    const start = Date.parse((await b.call(`/api/schedule/${e.id}`)).body.date ? new Date(remindMs(e) + 10 * 60_000).toISOString() : 0);
    await b.app.scheduler.tick(new Date(start - 11 * 60_000));
    assert.equal(b.sent.length, 0, 'not before the lead time');
    await b.app.scheduler.tick(new Date(start - 10 * 60_000 + 1000));
    assert.equal(b.sent.length, 1);
    assert.match(b.sent[0].message, /🎯 \*בעוד 10 דק׳: עע מצגת\*/);
    assert.match(b.sent[0].message, /משימה #1: מצגת — הצעד הבא: שלד/);
    await b.app.scheduler.tick(new Date(start - 5 * 60_000));
    assert.equal(b.sent.length, 1, 'only once');
    await b.call(`/api/schedule/${e.id}`, { method: 'PATCH', body: { start: '15:00', end: '15:45' } });
    await b.app.scheduler.tick(new Date(start + 2 * 3600_000 - 9 * 60_000));
    assert.equal(b.sent.length, 2, 'moved → reminded again');
  } finally { await b.close(); }
});
