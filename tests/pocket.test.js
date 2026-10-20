import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boot, AGENT_TOKEN } from './helpers.js';
import { extractPocket, pocketSpace, verifyPocket } from '../server/pocket.js';

const SECRET = 'pocket-test-secret';
const sign = (raw, ts = String(Date.now()), secret = SECRET) => ({ 'x-heypocket-timestamp': ts, 'x-heypocket-signature': createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex') });

async function deliver(b, payload, { user = 'me', headers } = {}) {
  const raw = JSON.stringify(payload);
  const res = await fetch(`${b.base}/hooks/pocket/${user}`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'HeyPocket-Webhook/1.0', ...(headers || sign(raw)) }, body: raw });
  return { status: res.status, body: await res.json() };
}
const until = async (fn) => { for (let i = 0; i < 100; i += 1) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); } assert.fail('timed out'); };
const tool = async (b, name, args = {}) => {
  const res = await fetch(`${b.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await res.json()).result.content[0].text;
};

const recording = (over = {}) => ({
  event: 'summary.completed',
  timestamp: new Date().toISOString(),
  user: { id: 'user_1', email: 'me@example.com' },
  recording: { id: 'rec_1', title: 'ישיבת צוות', duration: 1800, recordingAt: '2026-10-19T08:00:00.000Z', createdAt: '2026-10-19T08:40:00.000Z' },
  summarizations: {
    sum_1: {
      processingStatus: 'completed',
      v2: {
        summary: { markdown: 'סוכם על לוח זמנים חדש לפרויקט.' },
        actionItems: [
          { id: 'ai_1', title: 'לשלוח לדני את המסמך', dueDate: '2026-10-22', priority: 'high', assignee: 'Tal' },
          { id: 'ai_2', title: 'לקבוע פגישת המשך', completed: true },
        ],
      },
    },
  },
  transcript: [{ speaker: 'SPEAKER_00', text: 'סוד גדול שנאמר בפגישה', start: 0, end: 3 }],
  speakers: { SPEAKER_00: { name: 'Tal', speakerId: 'spk_1' } },
  ...over,
});

test('pocket: signature, timestamp window and unknown people are refused', async () => {
  const b = await boot({ pocketSpec: `me|${SECRET}` });
  try {
    const raw = JSON.stringify(recording());
    assert.equal((await deliver(b, recording(), { headers: {} })).status, 401, 'unsigned');
    assert.equal((await deliver(b, recording(), { headers: sign(raw, String(Date.now()), 'wrong') })).status, 401, 'wrong secret');
    assert.equal((await deliver(b, recording(), { headers: sign(raw, String(Date.now() - 3600_000)) })).status, 401, 'stale timestamp');
    assert.equal((await deliver(b, recording(), { user: 'someone' })).status, 404);
    assert.equal((await fetch(`${b.base}/hooks/pocket/me`)).status, 405);
    assert.equal((await b.call('/api/tasks')).body.items.length, 0);
    assert.ok(verifyPocket(SECRET, Buffer.from(raw), sign(raw, String(Math.floor(Date.now() / 1000)))), 'seconds are accepted too');
  } finally { await b.close(); }
});

test('pocket: without WORKBOARD_POCKET the hook does not exist', async () => {
  const b = await boot({ pocketSpec: '' });
  try { assert.equal((await deliver(b, recording())).status, 404); } finally { await b.close(); }
});

test('pocket: a summary becomes proposals awaiting approval and one WhatsApp message; retries change nothing', async () => {
  const b = await boot({ pocketSpec: `me|${SECRET}` });
  try {
    const r = await deliver(b, recording());
    assert.equal(r.status, 200);
    assert.equal(r.body.created.length, 1, 'a completed action item is not proposed');
    const task = (await b.call(`/api/tasks/${r.body.created[0]}`)).body;
    assert.equal(task.title, 'לשלוח לדני את המסמך');
    assert.equal(task.status, 'inbox', 'no review status on this board → the inbox');
    assert.equal(task.source, 'pocket');
    assert.equal(task.deadline, '2026-10-22');
    assert.equal(task.priority, 'high');
    assert.match(task.notes, /ישיבת צוות/);
    assert.match(task.notes, /אחראי לפי ההקלטה: Tal/);

    await until(() => b.sent.length === 1);
    const { message, meta } = b.sent[0];
    assert.equal(meta.event_type, 'workboard.pocket');
    assert.deepEqual(meta.tasks, [task.id]);
    assert.match(message, /ישיבת צוות/);
    assert.match(message, /לוח זמנים חדש/);
    assert.match(message, new RegExp(`#${task.id} לשלוח לדני`));

    const kept = await readFile(join(b.root, 'data', 'runtime', 'pocket-last.json'), 'utf8');
    assert.doesNotMatch(kept, /סוד גדול/, 'the transcript is never stored');

    // At-least-once delivery: the same event again creates nothing and sends nothing.
    assert.deepEqual((await deliver(b, recording())).body.created, []);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(b.sent.length, 1);

    // Regenerated action items: only the new one is proposed, with a short message.
    const again = recording({ event: 'action_items.regenerated' });
    again.summarizations.sum_1.v2.actionItems.push({ id: 'ai_3', title: 'להזמין חדר ישיבות' });
    const r2 = await deliver(b, again);
    assert.equal(r2.body.created.length, 1);
    await until(() => b.sent.length === 2);
    assert.match(b.sent[1].message, /משימות חדשות/);

    // The agent sees them as proposals, not as unsorted tasks it should file, and knows what was just sent.
    const board = await tool(b, 'board');
    assert.match(board, /ממתינות לאישור/);
    assert.match(board, new RegExp(`#${task.id}`));
    assert.doesNotMatch(board, /לא ממוינות/);
    assert.match(board, /🎙️ סיכום הקלטה "ישיבת צוות"/);

    // The person approves one: it leaves the proposals.
    await b.call(`/api/tasks/${task.id}`, { method: 'PATCH', body: { status: 'next' } });
    // Deleting the recording in Pocket archives only what was never approved.
    const del = await deliver(b, { event: 'recording.deleted', recording: { id: 'rec_1' } });
    assert.deepEqual(del.body.archived, r2.body.created);
    assert.equal((await b.call(`/api/tasks/${task.id}`)).body.archived, false);
  } finally { await b.close(); }
});

test('pocket: a "review" status on the board is used; a summary without items still notifies', async () => {
  const b = await boot({ pocketSpec: `me|${SECRET}` });
  try {
    const schema = (await b.call('/api/schema')).body;
    await b.call('/api/schema', { method: 'PATCH', body: { rev: schema.rev, statuses: [...schema.statuses, { id: 'review', label: 'לאישור', category: 'inbox', color: 'amber' }] } });
    const r = await deliver(b, recording());
    assert.equal((await b.call(`/api/tasks/${r.body.created[0]}`)).body.status, 'review');
    const empty = recording({ recording: { id: 'rec_2', title: 'שיחה קצרה' } });
    empty.summarizations.sum_1.v2.actionItems = [];
    assert.deepEqual((await deliver(b, empty)).body.created, []);
    await until(() => b.sent.length === 2);
    assert.match(b.sent[1].message, /לא זוהו משימות/);
    assert.equal((await deliver(b, { ...recording(), event: 'mind_map.completed' })).body.ignored, 'mind_map.completed');
  } finally { await b.close(); }
});

test('pocket: funnel traffic only reaches the hooks', async () => {
  const b = await boot({ pocketSpec: `me|${SECRET}` });
  try {
    const res = await fetch(`${b.base}/api/health`, { headers: { 'tailscale-funnel-request': '?1' } });
    assert.equal(res.status, 404);
    assert.equal((await fetch(`${b.base}/index.html`, { headers: { 'tailscale-funnel-request': '?1' } })).status, 404);
    assert.equal((await fetch(`${b.base}/hooks/pocket/../api/health`, { headers: { 'tailscale-funnel-request': '?1' } })).status, 404);
    assert.equal((await fetch(`${b.base}/api/health`)).status, 200);
  } finally { await b.close(); }
});

test('pocket: the real payload shape (flat summarizations array, fields under metadata)', () => {
  const info = extractPocket({
    event: 'summary.completed',
    recording: { id: 'r2', title: 'בדיקה', duration: 40, recordingAt: '2026-10-20T15:59:58.000Z' },
    summarizations: [{
      id: 's', summarizationId: 's2', settings: { language: 'Hebrew' }, summary: { markdown: 'סיכום קצר.' }, createdAt: '2026-10-20T16:01:00Z',
      actionItems: [
        { id: 'v3_a', title: 'לשלוח מצגת', task: 'לשלוח מצגת', description: 'הקשר', priority: 'medium', status: 'TODO', assignee: 'me', isCompleted: false, metadata: { id: 'v3_a', label: 'לשלוח מצגת', context: 'הקשר', dueDate: '2026-10-22T09:00:00.000Z', assignee: 'me', isCompleted: false } },
        { id: 'v3_b', title: 'כבר בוצע', status: 'DONE', metadata: { is_completed: true } },
        { id: 'v3_c', title: 'לבקש מדני', assignee: null, metadata: { assignee: 'Dani', dueDate: null } },
      ],
    }],
  });
  assert.equal(info.summary, 'סיכום קצר.');
  assert.equal(info.minutes, 1);
  const [a, b, c] = info.items;
  assert.deepEqual([a.key, a.title, a.due, a.assignee, a.context, a.done], ['id:v3_a', 'לשלוח מצגת', '2026-10-22', '', 'הקשר', false]);
  assert.equal(b.done, true);
  assert.equal(c.assignee, 'Dani');
  assert.equal(c.due, null);
});

test('pocket: payload parsing is tolerant; the space follows the work week', () => {
  const info = extractPocket({
    recording: { id: 'r', title: 'x' },
    summarizations: [
      { processingStatus: 'completed', updatedAt: '2026-10-01T00:00:00Z', v2: { actionItems: ['ישן'] } },
      { processingStatus: 'completed', updatedAt: '2026-10-02T00:00:00Z', v2: { summary: 'חדש', action_items: [{ text: 'לעשות א' }, { text: 'לעשות א' }, { task: 'לעשות ב', status: 'done' }] } },
      { processingStatus: 'processing', updatedAt: '2026-10-03T00:00:00Z', v2: { actionItems: ['בעיבוד'] } },
    ],
  });
  assert.equal(info.summary, 'חדש');
  assert.deepEqual(info.items.map((x) => [x.title, x.done]), [['לעשות א', false], ['לעשות ב', true]]);
  const people = { spaces: [{ id: 'w', owner: 'tal', kind: 'work' }, { id: 'l', owner: 'tal', kind: 'personal' }, { id: 'h', kind: 'home', members: ['tal'] }] };
  assert.equal(pocketSpace(people, 'tal', '2026-10-19T08:00:00Z'), 'w', 'Monday 11:00 Israel time');
  assert.equal(pocketSpace(people, 'tal', '2026-10-19T18:00:00Z'), 'l', 'Monday 21:00');
  assert.equal(pocketSpace(people, 'tal', '2026-10-17T08:00:00Z'), 'l', 'Saturday');
  assert.equal(pocketSpace(people, 'tal', null), 'w');
});

// A fake Pocket public API: list (paged) + details, shaped like the documented responses.
function fakeApi(recordings, { pageSize = 2 } = {}) {
  const calls = [];
  const json = (status, body) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body });
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    if (opts.headers.authorization !== 'Bearer pk_test') return json(401, { success: false, error: 'bad key', data: null });
    const detail = u.pathname.match(/\/public\/recordings\/([^/]+)$/);
    if (detail) {
      const r = recordings.find((x) => x.id === decodeURIComponent(detail[1]));
      return r ? json(200, { success: true, data: { ...r, transcript: { segments: [{ text: 'סוד' }] } } }) : json(404, { success: false, data: null });
    }
    const page = Number(u.searchParams.get('page')) || 1;
    const start = u.searchParams.get('start_date');
    const all = recordings.filter((r) => !start || r.recording_at.slice(0, 10) >= start);
    const data = all.slice((page - 1) * pageSize, page * pageSize).map(({ summarizations, ...r }) => r);
    return json(200, { success: true, data, pagination: { page, has_more: page * pageSize < all.length } });
  };
  return { fetchImpl, calls };
}
const apiRec = (id, at, items, extra = {}) => ({
  id, title: `הקלטה ${id}`, recording_at: at, created_at: at, updated_at: at, duration: 120, state: 'completed',
  summarizations: items === null ? null : [{ id: `s-${id}`, summary: { markdown: `סיכום ${id}` }, actionItems: items.map((t, i) => (typeof t === 'string' ? { id: `${id}-${i}`, title: t, status: 'TODO', metadata: { dueDate: null } } : t)) }],
  ...extra,
});

test('pocket polling: first run imports the history quietly with one message; later runs notify per recording', async () => {
  const day = (n) => new Date(Date.now() - n * 86400_000).toISOString();
  const recs = [
    apiRec('old', day(40), ['משימה ישנה', { id: 'old-done', title: 'בוצעה', metadata: { isCompleted: true } }]),
    apiRec('mid', day(10), ['משימה א', 'משימה ב']),
    apiRec('busy', day(1), null), // still processing: no summary yet
  ];
  const { fetchImpl, calls } = fakeApi(recs);
  const b = await boot({ pocketSpec: '', pocketOptions: { apiSpec: 'me|pk_test', fetchImpl, pauseMs: 0, retryMs: 0 } });
  try {
    const [first] = await b.app.pocket.poll();
    assert.equal(first.backfill, true);
    assert.equal(first.imported, 2);
    assert.equal(first.tasks, 3, 'completed items are skipped');
    assert.ok(calls.some((c) => c.includes('page=2')), 'follows pagination');
    assert.ok(calls.every((c) => !c.includes('start_date')), 'the first run reads the whole history');
    assert.equal(b.sent.length, 1, 'one message for the whole import');
    assert.match(b.sent[0].message, /ייבוא מ־Pocket הושלם/);
    assert.match(b.sent[0].message, /2 הקלטות/);
    assert.match(b.sent[0].message, /3 משימות/);
    const tasks = (await b.call('/api/tasks')).body.items;
    assert.equal(tasks.length, 3);
    assert.ok(tasks.every((t) => t.source === 'pocket' && t.status === 'inbox'));

    // Nothing changed → nothing happens, and no detail calls for known recordings.
    calls.length = 0;
    const [second] = await b.app.pocket.poll();
    assert.equal(second.backfill, false);
    assert.ok(calls.some((c) => c.includes('start_date=')), 'later runs look at the last days only');
    assert.equal(calls.filter((c) => /recordings\/(old|mid)/.test(c)).length, 0);
    assert.equal(b.sent.length, 1);

    // The busy recording finishes, and a new one arrives: one normal message each.
    Object.assign(recs[2], apiRec('busy', recs[2].recording_at, ['לסיים את הדוח']), { updated_at: new Date().toISOString() });
    recs.push(apiRec('new', day(0), []));
    await b.app.pocket.poll();
    assert.equal(b.sent.length, 3);
    assert.ok(b.sent.some((x) => /לסיים את הדוח/.test(x.message)));
    assert.ok(b.sent.some((x) => /לא זוהו משימות/.test(x.message)));
    assert.equal((await b.call('/api/tasks')).body.items.length, 4);
  } finally { await b.close(); }
});

test('pocket polling and the webhook share one ledger: nothing is filed twice', async () => {
  const at = new Date(Date.now() - 3600_000).toISOString();
  const recs = [apiRec('rec_1', at, [{ id: 'ai_1', title: 'לשלוח לדני את המסמך', metadata: {} }])];
  const { fetchImpl } = fakeApi(recs);
  const b = await boot({ pocketSpec: `me|${SECRET}`, pocketOptions: { apiSpec: 'me|pk_test', fetchImpl, pauseMs: 0, retryMs: 0 } });
  try {
    assert.equal((await deliver(b, recording())).body.created.length, 1);
    await until(() => b.sent.length === 1);
    const [r] = await b.app.pocket.poll();
    assert.equal(r.tasks, 0);
    assert.equal((await b.call('/api/tasks')).body.items.length, 1);
  } finally { await b.close(); }
});

test('pocket polling: a bad key is reported, not thrown', async () => {
  const { fetchImpl } = fakeApi([]);
  const b = await boot({ pocketSpec: '', pocketOptions: { apiSpec: 'me|pk_wrong', fetchImpl, pauseMs: 0 } });
  try {
    const [r] = await b.app.pocket.poll();
    assert.match(r.error, /401/);
    assert.equal(b.sent.length, 0);
  } finally { await b.close(); }
});
