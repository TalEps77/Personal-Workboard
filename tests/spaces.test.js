import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { guessDept } from '../server/shopping.js';

const PEOPLE = {
  users: [{ id: 'avi', name: 'אבי', agent: 'אטלס' }, { id: 'maya', name: 'מאיה', agent: 'נובה' }],
  spaces: [
    { id: 'work', label: 'עבודה', owner: 'avi', kind: 'work' },
    { id: 'avi-life', label: 'אישי', owner: 'avi', kind: 'personal' },
    { id: 'home', label: 'בית', kind: 'home', members: ['avi', 'maya'] },
    { id: 'maya-work', label: 'עבודה', owner: 'maya', kind: 'work' },
    { id: 'maya-life', label: 'אישי', owner: 'maya', kind: 'personal' },
  ],
  defaultSpace: 'work',
  defaultUser: 'avi',
};
const AVI = 'avi-token'; const NOVA = 'nova-token';

async function boot() {
  const root = await mkdtemp(join(tmpdir(), 'workboard-spaces-'));
  const sent = [];
  const notifier = { configured: true, configuredFor: () => true, send: async (message, meta) => { sent.push({ message, meta }); } };
  const app = createApp({ root, people: PEOPLE, notifier, schedulerInterval: 1e9, agentToken: AVI, agentTokens: `maya:nova:${NOVA}` });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const sessions = { avi: await app.auth.createSessionForTests('t', 'avi'), maya: await app.auth.createSessionForTests('p', 'maya') };
  const call = async (who, path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(method !== 'GET' && { 'content-type': 'application/json' }), cookie: `wb_session=${sessions[who]}` }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const tool = async (token, name, args = {}) => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const b = await res.json();
    return b.result.content[0].text;
  };
  return { app, call, tool, sent, close: async () => { app.scheduler.stop(); await new Promise((r) => app.server.close(r)); await rm(root, { recursive: true, force: true }); } };
}

test('spaces: nobody sees the other person\'s work or personal tasks — not via REST, MCP, activity or undo', async () => {
  const b = await boot();
  try {
    const secret = (await b.call('avi', '/api/tasks', { method: 'POST', body: { title: 'מצגת סודית ללקוח' } })).body;
    assert.equal(secret.space, 'work');
    const mine = (await b.call('maya', '/api/tasks', { method: 'POST', body: { title: 'לקבוע תור לרופאת שיניים', space: 'maya-life' } })).body;
    assert.equal((await b.call('maya', `/api/tasks/${secret.id}`)).status, 404);
    assert.equal((await b.call('maya', `/api/tasks/${secret.id}`, { method: 'PATCH', body: { title: 'x' } })).status, 404);
    assert.equal((await b.call('maya', `/api/tasks/${secret.id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await b.call('maya', '/api/tasks', { method: 'POST', body: { title: 'x', space: 'work' } })).status, 403);
    assert.equal((await b.call('maya', `/api/tasks/${mine.id}`, { method: 'PATCH', body: { space: 'avi-life' } })).status, 403);
    const boot1 = (await b.call('maya', '/api/bootstrap')).body;
    assert.deepEqual(boot1.tasks.map((t) => t.id), [mine.id]);
    assert.ok(!JSON.stringify(boot1.activity).includes('מצגת סודית'));
    assert.deepEqual(boot1.spaces.map((s) => s.id), ['home', 'maya-work', 'maya-life']);
    assert.equal(boot1.me.id, 'maya');
    const talEntry = (await b.call('avi', '/api/activity')).body.items.find((a) => a.task === secret.id);
    assert.equal((await b.call('maya', `/api/activity/${talEntry.id}/undo`, { method: 'POST' })).status, 404);
    const found = await b.tool(NOVA, 'find_tasks', { query: 'מצגת' });
    assert.match(found, /לא נמצאו/);
    assert.match(await b.tool(NOVA, 'update_tasks', { updates: [{ id: Number(secret.id), title: 'x' }] }), /not found/);
    assert.ok(!(await b.tool(NOVA, 'history')).includes('מצגת'));
    await b.tool(AVI, 'projects', { upsert: { name: 'פרויקט סודי' } });
    assert.ok(!JSON.stringify((await b.call('maya', '/api/activity')).body).includes('פרויקט סודי'), 'structure history is not hers');
    assert.ok(!(await b.tool(NOVA, 'history')).includes('מבנה'));
    // Avi (and his agent) see his own; not hers.
    assert.equal((await b.call('avi', `/api/tasks/${mine.id}`)).status, 404);
    assert.match(await b.tool(AVI, 'find_tasks', { query: 'מצגת' }), /מצגת סודית/);
  } finally { await b.close(); }
});

test('home space: shared tasks, "on whom", and the agenda only shows what is mine', async () => {
  const b = await boot();
  try {
    const created = await b.tool(AVI, 'create_tasks', { tasks: [{ title: 'להזמין אינסטלטור', space: 'home', when: 'today' }, { title: 'לשלם ארנונה', space: 'home', assignee: 'maya', when: 'today' }, { title: 'לקנות מתנה לאמא', space: 'personal', when: 'today' }] });
    assert.match(created, /🏠 בית \(עליי\)/);
    assert.match(created, /👤 אישי/);
    assert.doesNotMatch(created, /אינו יום עבודה/);
    const her = await b.tool(NOVA, 'board');
    assert.match(her, /לשלם ארנונה/, 'assigned to her');
    assert.doesNotMatch(her, /אינסטלטור/, 'Avi took it');
    assert.doesNotMatch(her, /מתנה לאמא/, 'Avi\'s personal');
    const his = await b.tool(AVI, 'board');
    assert.match(his, /אינסטלטור/);
    assert.match(his, /מתנה לאמא/);
    assert.doesNotMatch(his, /ארנונה/);
    // She can still find and change shared tasks that aren't on her.
    assert.match(await b.tool(NOVA, 'find_tasks', { space: 'home' }), /אינסטלטור/);
    assert.match(await b.tool(NOVA, 'update_tasks', { updates: [{ id: 1, assignee: 'both' }] }), /על: שנינו/);
    assert.match(await b.tool(NOVA, 'board'), /אינסטלטור/);
  } finally { await b.close(); }
});

test('reminders and schedule heads-ups go to the right person\'s WhatsApp', async () => {
  const b = await boot();
  try {
    const t = (await b.call('maya', '/api/tasks', { method: 'POST', body: { title: 'לתאם טכנאי', space: 'home' } })).body;
    await b.call('maya', `/api/tasks/${t.id}/reminders`, { method: 'POST', body: { at: new Date(Date.now() - 60_000).toISOString() } });
    const own = (await b.call('avi', '/api/tasks', { method: 'POST', body: { title: 'עבודה', space: 'work' } })).body;
    await b.call('avi', `/api/tasks/${own.id}/reminders`, { method: 'POST', body: { at: new Date(Date.now() - 60_000).toISOString() } });
    await b.app.scheduler.tick(new Date());
    const to = (title) => b.sent.filter((x) => x.meta.event_type === 'workboard.reminder' && x.meta.title === title).map((x) => x.meta.to);
    assert.deepEqual(to('לתאם טכנאי'), ['maya'], 'whoever set it on a shared task');
    assert.deepEqual(to('עבודה'), ['avi']);
    // Schedule: private items stay private; shared items go to both.
    const day = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    await b.call('maya', '/api/schedule', { method: 'POST', body: { title: 'פגישה שלה', date: day, start: '10:00' } });
    await b.tool(AVI, 'add_events', { events: [{ title: 'טכנאי מזגנים', date: day, start: '12:00', shared: true }] });
    const talCal = await b.tool(AVI, 'calendar', { from: day, days: 1 });
    assert.match(talCal, /טכנאי מזגנים/);
    assert.doesNotMatch(talCal, /פגישה שלה/);
    const herCal = await b.tool(NOVA, 'calendar', { from: day, days: 1 });
    assert.match(herCal, /טכנאי מזגנים/);
    assert.match(herCal, /פגישה שלה/);
    assert.deepEqual(b.app.access.recipientsOfEvent({ owner: 'home' }).sort(), ['avi', 'maya']);
    // Each item carries its space (its colour): given, from the linked task, shared → home, else work.
    await b.tool(AVI, 'add_events', { events: [{ title: 'רופא שיניים', date: day, start: '08:00', space: 'personal' }, { title: 'ישיבת צוות', date: day, start: '09:00' }] });
    const evs = (await b.call('avi', `/api/schedule?from=${day}&to=${day}`)).body.items;
    const sp = (t) => evs.find((e) => e.title === t)?.space;
    assert.equal(sp('רופא שיניים'), 'avi-life');
    assert.equal(sp('ישיבת צוות'), 'work');
    assert.equal(sp('טכנאי מזגנים'), 'home');
  } finally { await b.close(); }
});

test('projects of other people\'s spaces are invisible and survive their edits', async () => {
  const b = await boot();
  try {
    await b.tool(AVI, 'projects', { upsert: { name: 'מצגת ללקוח' } });
    await b.tool(NOVA, 'projects', { upsert: { name: 'שיפוץ מטבח', space: 'home' } });
    const herSchema = (await b.call('maya', '/api/schema')).body;
    assert.deepEqual(herSchema.projects.map((p) => p.name), ['שיפוץ מטבח']);
    const renamed = herSchema.projects.map((p) => ({ ...p, name: 'שיפוץ המטבח' }));
    assert.equal((await b.call('maya', '/api/schema', { method: 'PATCH', body: { projects: renamed, rev: herSchema.rev } })).status, 200);
    const talSchema = (await b.call('avi', '/api/schema')).body;
    assert.ok(talSchema.projects.some((p) => p.name === 'מצגת ללקוח'), 'her edit must not remove his project');
    assert.ok(talSchema.projects.some((p) => p.name === 'שיפוץ המטבח' && p.space === 'home'), 'shared project visible to him');
    assert.equal((await b.call('maya', '/api/schema', { method: 'PATCH', body: { projects: [...renamed, { id: talSchema.projects.find((p) => p.name === 'מצגת ללקוח').id, name: 'hijack' }], rev: talSchema.rev } })).status, 409, 'cannot overwrite a project she cannot see');
  } finally { await b.close(); }
});

test('shopping list: departments are guessed and learned, duplicates merge, finish clears ticked items', async () => {
  assert.equal(guessDept('עגבניות שרי'), 'produce');
  assert.equal(guessDept('חלב 3%'), 'dairy');
  assert.equal(guessDept('מים מינרלים'), 'drinks');
  assert.equal(guessDept('נייר טואלט'), 'cleaning');
  const b = await boot();
  try {
    let out = await b.tool(AVI, 'shopping', { add: [{ text: 'עגבניות' }, { text: 'חלב', qty: '2' }, { text: 'זעתר' }] });
    assert.match(out, /🥬 פירות וירקות: עגבניות/);
    assert.match(out, /חלב \(2\)/);
    out = await b.tool(NOVA, 'shopping', { add: [{ text: 'חלב' }], move: [{ item: 'זעתר', dept: 'deli' }] });
    assert.match(out, /כבר ברשימה: חלב/);
    assert.match(out, /זעתר → סופר · מעדנייה/);
    await b.tool(NOVA, 'shopping', { remove: ['זעתר'] });
    assert.match(await b.tool(AVI, 'shopping', { add: [{ text: 'זעתר' }] }), /זעתר → סופר · מעדנייה וסלטים/, 'learned');
    out = await b.tool(AVI, 'shopping', { check: ['עגבניות', 'חלב'], finish: true });
    assert.match(out, /2 פריטים שנקנו ירדו/);
    const list = (await b.call('maya', '/api/shopping')).body;
    assert.deepEqual(list.items.map((x) => x.text), ['זעתר']);
    assert.ok(list.recent.some((r) => r.text === 'עגבניות'));
  } finally { await b.close(); }
});

test('pairing: the code goes to the WhatsApp of the person who asked', async () => {
  const b = await boot();
  try {
    const res = await fetch(`${b.app.server.address().port && `http://127.0.0.1:${b.app.server.address().port}`}/api/auth/request-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'maya' }) });
    assert.equal(res.status, 200);
    const msg = b.sent.find((x) => x.meta.event_type === 'workboard.pairing');
    assert.equal(msg.meta.to, 'maya');
    const status = await (await fetch(`http://127.0.0.1:${b.app.server.address().port}/api/auth/status`)).json();
    assert.deepEqual(status.users.map((u) => u.id), ['avi', 'maya']);
  } finally { await b.close(); }
});

test('shopping lists: five shared household lists; who added shows on personal and wish; claims hidden from the wisher', async () => {
  const b = await boot();
  try {
    await b.tool(AVI, 'shopping', { add: [{ text: 'שמפו', list: 'pharm' }, { text: 'מדפים', list: 'house' }, { text: 'נעלי ריצה', list: 'personal' }, { text: 'מצלמה', list: 'wish' }] });
    const hers = (await b.call('maya', '/api/shopping')).body;
    assert.deepEqual(hers.lists.map((l) => l.id), ['super', 'pharm', 'house', 'personal', 'wish']);
    assert.deepEqual(hers.items.map((x) => x.text).sort(), ['מדפים', 'מצלמה', 'נעלי ריצה', 'שמפו'], 'everything is shared');
    assert.match(await b.tool(NOVA, 'shopping', { list: 'personal' }), /נעלי ריצה · של אבי/);
    assert.doesNotMatch(await b.tool(NOVA, 'shopping', { list: 'pharm' }), /של אבי/, 'no byline on shared shop lists');
    const cam = hers.items.find((x) => x.text === 'מצלמה');
    assert.equal((await b.call('maya', `/api/shopping/${cam.id}/claim`, { method: 'POST', body: { claimed: true } })).body.claimed_by, 'maya');
    assert.equal((await b.call('maya', '/api/shopping')).body.items.find((x) => x.id === cam.id).claimed_by, 'maya');
    assert.equal((await b.call('avi', '/api/shopping')).body.items.find((x) => x.id === cam.id).claimed_by, undefined, 'the one who wished never sees it');
    assert.doesNotMatch(await b.tool(AVI, 'shopping', { list: 'wish' }), /🤫/);
    assert.equal((await b.call('avi', `/api/shopping/${cam.id}/claim`, { method: 'POST', body: { claimed: true } })).status, 400, 'not your own wish');
    await b.tool(NOVA, 'shopping', { add: [{ text: 'ספר בישול', list: 'wish' }] });
    assert.match(await b.tool(AVI, 'shopping', { claim: ['ספר בישול'] }), /רק אתה רואה/);
    assert.doesNotMatch(await b.tool(NOVA, 'shopping', { list: 'wish' }), /ספר בישול[^\n]*🤫/);
  } finally { await b.close(); }
});
