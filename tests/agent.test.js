import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, AGENT_TOKEN } from './helpers.js';
import { resolveAt, resolveDate } from '../server/dates.js';
import { agenda } from '../server/summary.js';
import { EFFORT_FIELD, KIND_FIELD, focusList } from '../public/js/focus.js';
import { addDays, today } from '../server/time.js';

const SUNDAY_2PM = new Date('2026-10-11T14:00:00+03:00');
const FRIDAY = new Date('2026-10-16T10:00:00+03:00');

test('date words resolve on the server (Israel time, Sun–Thu week)', () => {
  const r = (x, now = SUNDAY_2PM) => resolveDate(x, now);
  assert.equal(r('מחר'), '2026-10-12');
  assert.equal(r('ראשון'), '2026-10-18', 'a weekday name is never today');
  assert.equal(r('ראשון הבא'), '2026-10-18');
  assert.equal(r('רביעי'), '2026-10-14');
  assert.equal(r('next-week'), '2026-10-18');
  assert.equal(r('סוף השבוע'), '2026-10-15', 'end of the work week is Thursday');
  assert.equal(r('next-workday', FRIDAY), '2026-10-18');
  assert.equal(r('סוף השבוע', FRIDAY), '2026-10-22');
  assert.equal(r('+3d'), '2026-10-14');
  assert.equal(r('21.10'), '2026-10-21');
  assert.equal(r('1.1'), '2027-01-01', 'a past day-month means next year');
  assert.equal(r('none'), null);
  assert.throws(() => r('בקרוב'), /Unknown date/);
  const a = (x) => resolveAt(x, SUNDAY_2PM);
  assert.equal(a('+90m').time, '15:30');
  assert.equal(a('17:00').date, '2026-10-11');
  assert.equal(a('10:00').date, '2026-10-12', 'a time already past today means tomorrow');
  assert.match(a('10:00').label, /נקבע למחר/);
  assert.equal(a('ראשון ב09:30').date, '2026-10-18');
  assert.equal(a('מחר בבוקר').time, '09:00');
  assert.equal(a('2026-10-12T09:00').iso, '2026-10-12T06:00:00.000Z');
  assert.throws(() => a('2026-10-10T09:00'), /in the past/);
});

test('agenda: waiting work is a follow-up, not today\'s to-do; carried-over is separate from planned', () => {
  const schema = { statuses: [{ id: 'next', label: 'הבא בתור', category: 'todo' }, { id: 'doing', label: 'בעבודה', category: 'active' }, { id: 'waiting', label: 'ממתין למישהו', category: 'active' }, { id: 'done', label: 'בוצע', category: 'done' }, { id: 'inbox', label: 'לא ממוין', category: 'inbox' }], priorities: [{ id: 'normal', rank: 2 }] };
  const t = today(SUNDAY_2PM);
  const mk = (id, extra) => ({ id: String(id), title: `t${id}`, status: 'next', priority: 'normal', reminders: [], steps: [], tags: [], fields: {}, ...extra });
  const a = agenda([
    mk(1, { when: t }), mk(2, { when: addDays(t, -2) }), mk(3, { status: 'waiting', when: addDays(t, -1) }),
    mk(4, { status: 'waiting', when: addDays(t, 3) }), mk(5, { deadline: t }), mk(6, { deadline: addDays(t, -1) }),
    mk(7, { when: addDays(t, 2) }), mk(8, { status: 'doing' }), mk(9, { status: 'done', when: t }), mk(10, { status: 'inbox' }),
  ], schema, SUNDAY_2PM);
  const ids = (list) => list.map((x) => x.id);
  assert.deepEqual(ids(a.planned), ['1']);
  assert.deepEqual(ids(a.carried), ['2']);
  assert.deepEqual(ids(a.followups), ['3']);
  assert.deepEqual(ids(a.dueToday), ['5']);
  assert.deepEqual(ids(a.overdue), ['6']);
  assert.deepEqual(ids(a.week), ['4', '7']);
  assert.deepEqual(ids(a.active), ['8']);
  assert.deepEqual(ids(a.inbox), ['10']);
});

async function mcp(b, method, params, { token = AGENT_TOKEN, id = 1 } = {}) {
  const res = await fetch(`${b.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}
const tool = async (b, name, args) => {
  const { body } = await mcp(b, 'tools/call', { name, arguments: args });
  return { text: body.result.content[0].text, error: body.result.isError === true };
};

test('MCP: handshake, auth, tool list', async () => {
  const b = await boot();
  try {
    assert.equal((await mcp(b, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }, { token: null })).status, 401);
    const init = await mcp(b, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.body.result.protocolVersion, '2025-03-26');
    assert.equal((await fetch(`${b.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).status, 202);
    const names = (await mcp(b, 'tools/list')).body.result.tools.map((t) => t.name);
    assert.deepEqual(names, ['board', 'find_tasks', 'create_tasks', 'update_tasks', 'remind', 'focus', 'projects', 'calendar', 'add_events', 'update_events', 'shopping', 'history', 'undo']);
    assert.equal((await mcp(b, 'nope/x')).body.error.code, -32601);
  } finally { await b.close(); }
});

test('MCP: a typical WhatsApp day in a few calls, with short Hebrew answers', async () => {
  const b = await boot();
  try {
    await b.call('/api/schema', { method: 'PATCH', body: { projects: [{ id: 'portal', name: 'פורטל', aliases: ['פורטל הלקוחות', 'portal'] }], fields: [{ id: 'with', label: 'עם מי', type: 'text' }] } });
    let r = await tool(b, 'create_tasks', { tasks: [
      { title: 'לסדר הרשאות לפורטל מול אבי', project: 'פורטל הלקוחות', status: 'waiting', with: 'אבי', deadline: 'סוף השבוע', steps: ['לדבר עם אבי', 'לבדוק'] },
      { title: 'לקנות מטען למשרד', when: 'today', remind: { at: '+2h', note: 'בדרך הביתה' } },
      { title: 'משהו', project: 'אין כזה' },
    ] });
    assert.match(r.text, /✅ נוצרה #1 לסדר הרשאות לפורטל מול אבי · ממתין למישהו · 📁 פורטל/);
    assert.match(r.text, /עם: אבי/);
    assert.match(r.text, /✅ נוצרה #2 .*⏰ (היום|מחר)/); // +2h can cross midnight
    assert.match(r.text, /❌ פריט 3 .*Unknown project/, 'one bad item does not fail the batch');
    r = await tool(b, 'create_tasks', { tasks: [{ title: 'לקנות מטען חדש למשרד' }] });
    assert.match(r.text, /אולי כפולה של #2/);

    r = await tool(b, 'board', {});
    assert.match(r.text, /^עכשיו: /);
    assert.match(r.text, /ימים: /);
    assert.match(r.text, /פרויקטים: portal=פורטל/);
    assert.ok(r.text.length < 2500, `board stays compact (${r.text.length} chars)`);

    r = await tool(b, 'update_tasks', { updates: [{ id: 1, check_steps: [1], append_note: 'דיברנו' }, { id: 2, done: true }, { id: 99, done: true }] });
    assert.match(r.text, /✅ #1 .*☑1\/2 .*undo: a/);
    assert.match(r.text, /✅ #2 .*בוצע/);
    assert.match(r.text, /❌ #99: Task 99 not found/);
    const t1 = (await b.call('/api/tasks/1')).body;
    assert.equal(t1.notes, 'דיברנו');
    assert.equal(t1.fields.with, 'אבי');

    r = await tool(b, 'find_tasks', { with: 'אבי', detail: true });
    assert.match(r.text, /1\. ☑ לדבר עם אבי/);
    assert.match(r.text, /הערות: דיברנו/);
    r = await tool(b, 'find_tasks', { query: '#2', include_done: true });
    assert.match(r.text, /#2 לקנות מטען למשרד · בוצע/);
  } finally { await b.close(); }
});

test('MCP remind: "latest" moves the reminder that fired instead of adding a second one', async () => {
  const b = await boot();
  try {
    await tool(b, 'create_tasks', { tasks: [{ title: 'מפתחות מהשכן', remind: { at: '+1m' } }] });
    const rid = (await b.call('/api/tasks/1')).body.reminders[0].id;
    await b.app.scheduler.tick(new Date(Date.now() + 5 * 60_000));
    assert.equal(b.sent.length, 1);
    let r = await tool(b, 'board', {});
    assert.match(r.text, new RegExp(`תזכורות שנשלחו.*\\n• \\d\\d:\\d\\d → #1 מפתחות מהשכן \\[${rid}\\]`));
    r = await tool(b, 'remind', { task: 1, reminder_id: 'latest', at: '+1h' });
    assert.match(r.text, new RegExp(`⏰ הוזזה: #1 מפתחות מהשכן → .* \\[${rid}\\]`));
    const task = (await b.call('/api/tasks/1')).body;
    assert.equal(task.reminders.length, 1);
    assert.equal(task.reminders[0].done, false);
    r = await tool(b, 'remind', { task: 1, at: 'מחר 09:00' });
    assert.match(r.text, /למשימה יש עוד תזכורת פעילה/);
    r = await tool(b, 'remind', { task: 1, at: '2001-01-01T09:00' });
    assert.ok(r.error);
    assert.match(r.text, /in the past/);
    r = await tool(b, 'history', { task: 1 });
    assert.match(r.text, /agent: #1/);
    const undoId = r.text.match(/undo: (a\w+)/)[1];
    r = await tool(b, 'undo', { activity_id: undoId });
    assert.match(r.text, /↩️ בוטל/);
  } finally { await b.close(); }
});

test('review round 2: impossible dates rejected, Hebrew phrasing, year rollover flagged', () => {
  const r = (x) => resolveDate(x, SUNDAY_2PM);
  assert.throws(() => r('31.2'), /not a real date/);
  assert.throws(() => r('2027-02-31'), /not a real date/);
  assert.throws(() => resolveAt('2026-10-12T25:70', SUNDAY_2PM), /not a real date\/time/);
  assert.equal(r('ב׳'), '2026-10-12');
  assert.equal(r('חמישי שאחרי'), '2026-10-22');
  assert.equal(r('חמישי אחרי 18.10'), '2026-10-22');
  const a = (x) => resolveAt(x, SUNDAY_2PM);
  assert.equal(a('מחר ב-7:30').time, '07:30');
  assert.equal(a('מחר 7:30 בערב').time, '19:30');
  assert.equal(a('מחר 7:30 בבוקר').time, '07:30');
  assert.equal(a('עוד שעה').time, '15:00');
  assert.equal(a('בעוד חצי שעה').time, '14:30');
});

test('review round 2: tools are honest — no-op, done tasks, failed deliveries, full notes, ids + filters, projects', async () => {
  const b = await boot({ notifier: { configured: true, send: async () => { throw Object.assign(new Error('Hermes answered 502'), { definite: true }); } } });
  try {
    await tool(b, 'create_tasks', { tasks: [{ title: 'אחת', notes: `${'א'.repeat(700)} סוף-ההערה` }, { title: 'שתיים', status: 'waiting' }] });
    let r = await tool(b, 'update_tasks', { updates: [{ id: 1, append_note: 'עוד' }] });
    assert.match(r.text, /undo: a/);
    r = await tool(b, 'update_tasks', { updates: [{ id: 1, status: 'next' }] });
    assert.match(r.text, /לא היה מה לשנות/);
    assert.doesNotMatch(r.text, /undo: a/);
    r = await tool(b, 'find_tasks', { ids: [1], detail: true });
    assert.match(r.text, /סוף-ההערה/, 'few results → complete notes');
    r = await tool(b, 'find_tasks', { ids: [1, 2], status: 'waiting' });
    assert.match(r.text, /#2/); assert.doesNotMatch(r.text, /#1 /);
    await tool(b, 'update_tasks', { updates: [{ id: 2, done: true }] });
    r = await tool(b, 'remind', { task: 2, at: '+1h' });
    assert.ok(r.error); assert.match(r.text, /is done/);
    await tool(b, 'remind', { task: 1, at: '+1m' });
    for (let i = 0; i < 9; i += 1) await b.app.scheduler.tick(new Date(Date.now() + (5 + i * 70) * 60_000));
    r = await tool(b, 'board', {});
    assert.match(r.text, /תזכורות שלא נמסרו/);
    assert.match(r.text, /#1 אחת .*לא נמסרה/);
    r = await tool(b, 'projects', { upsert: { name: 'website', add_aliases: ['אתר'], due: '21.10' } });
    assert.match(r.text, /✅ נוצר פרויקט website = website · כינויים: אתר/);
    r = await tool(b, 'create_tasks', { tasks: [{ title: 'באג', project: 'אתר' }] });
    assert.match(r.text, /📁 website/);
    r = await tool(b, 'projects', { upsert: { id: 'אתר', goal: 'באוויר' } });
    assert.match(r.text, /עודכן פרויקט website .*יעד: באוויר/);
  } finally { await b.close(); }
});

test('work type: set via tools, filtered, and "free time" ranks independent work by urgency', async () => {
  const b = await boot();
  try {
    await b.call('/api/schema', { method: 'PATCH', body: { fields: [KIND_FIELD] } });
    const t = today();
    await tool(b, 'create_tasks', { tasks: [
      { title: 'מצגת ללקוח', kind: 'solo', when: 'next-week' },
      { title: 'דוח דחוף', kind: 'solo', deadline: 'tomorrow', priority: 'urgent', steps: ['א', 'ב'] },
      { title: 'לתאם עם מאיה', kind: 'coord' },
      { title: 'מעקב אחרי הספק', kind: 'followup', status: 'waiting' },
      { title: 'ללא סוג' },
      { title: 'רעיון', kind: 'solo', status: 'someday' },
    ] });
    let r = await tool(b, 'update_tasks', { updates: [{ id: 2, check_steps: [1] }, { id: 5, kind: 'בלגן' }] });
    assert.match(r.text, /❌ #5: Unknown kind/);
    r = await tool(b, 'find_tasks', { kind: 'solo' });
    assert.match(r.text, /3 משימות/);
    assert.match(r.text, /עבודה עצמאית/);
    r = await tool(b, 'find_tasks', { kind: 'none' });
    assert.match(r.text, /#5 ללא סוג/);
    r = await tool(b, 'focus', {});
    const lines = r.text.split('\n');
    assert.match(lines[2], /^1\. #2 דוח דחוף — דדליין מחר, דחוף, באמצע \(1\/2\) · הצעד הבא: ב$/);
    assert.match(lines[3], /^2\. #1 מצגת ללקוח/);
    assert.match(lines[4], /^3\. #6 רעיון.*\(מתישהו\)/);
    assert.match(r.text, /1 משימות פתוחות בלי סוג/);
    r = await tool(b, 'focus', { mode: 'coord' });
    assert.match(r.text, /1\. #3 לתאם עם מאיה/);
    const schema = (await b.call('/api/schema')).body;
    const ranked = focusList((await b.call('/api/tasks')).body.items, schema, t);
    assert.deepEqual(ranked.map((x) => x.task.id), ['2', '1', '6'], 'dashboard and agent share one ranking');
  } finally { await b.close(); }
});

test('effort: set via tools, and "I have half an hour" keeps only what fits', async () => {
  const b = await boot();
  try {
    await b.call('/api/schema', { method: 'PATCH', body: { fields: [KIND_FIELD, EFFORT_FIELD] } });
    await tool(b, 'create_tasks', { tasks: [
      { title: 'מייל קצר', kind: 'solo', effort: '15m' },
      { title: 'מצגת', kind: 'solo', effort: '4h', priority: 'urgent' },
      { title: 'לא ידוע', kind: 'solo' },
    ] });
    let r = await tool(b, 'find_tasks', { query: 'מייל' });
    assert.match(r.text, /⏱ רבע שעה/);
    r = await tool(b, 'focus', { minutes: 30 });
    assert.match(r.text, /מה נכנס ב־30 דק׳/);
    assert.match(r.text, /1\. #1 מייל קצר/);
    assert.match(r.text, /2\. #3 לא ידוע/);
    assert.doesNotMatch(r.text, /מצגת/);
    r = await tool(b, 'focus', {});
    assert.match(r.text, /1\. #2 מצגת/, 'without a time limit, urgency leads');
    r = await tool(b, 'update_tasks', { updates: [{ id: 3, effort: '45m' }] });
    assert.match(r.text, /⏱ שעה/, '45 minutes rounds up to the hour bucket');
  } finally { await b.close(); }
});
