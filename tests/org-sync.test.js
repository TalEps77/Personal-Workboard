// The optional team-board link (server/org-sync.js), against a small fake team board.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { boot, AGENT_TOKEN } from './helpers.js';
import { parseOrgTokens } from '../server/org-sync.js';

const TOKEN = 'team-sync-token';
async function fakeTeam() {
  const me = { id: 1, name: 'טל' };
  const team = { tasks: new Map(), gone: [], cursor: 1, requests: [], deny: new Set() };
  const shape = (t) => ({ ...t, responsible: t.responsible || me, reviewer: t.reviewer || { id: 2, name: 'רונה' }, slips: t.slips || 0 });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (s, d) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
      const input = body ? JSON.parse(body) : {};
      team.requests.push({ method: req.method, url: req.url, input });
      if (req.url.startsWith('/api/sync')) { team.cursor += 1; const gone = team.gone; team.gone = []; return send(200, { me, cursor: team.cursor, tasks: [...team.tasks.values()].map(shape), gone }); }
      const m = req.url.match(/^\/api\/tasks\/(\d+)$/);
      if (m && req.method === 'PATCH') {
        const t = team.tasks.get(Number(m[1]));
        if (input.title !== undefined && team.deny.has('title')) return send(403, { error: 'forbidden', message: 'Only the reviewer or a manager can change the title' });
        if (input.due !== undefined && t.due && !input.reason) return send(400, { error: 'reason_required', message: 'Moving a due date needs a reason' });
        if (input.status) t.status = input.status;
        if (input.due !== undefined) { if (t.due && input.due > t.due) t.slips = (t.slips || 0) + 1; t.due = input.due; }
        if (input.title !== undefined) t.title = input.title;
        if (input.description !== undefined) t.description = input.description;
        t.rev += 1;
        return send(200, { task: shape(t) });
      }
      if (req.url === '/api/tasks' && req.method === 'POST') {
        const id = 100 + team.tasks.size;
        const t = { id, title: input.title, description: input.description, due: input.due, status: 'open', rev: 1, origin: input.origin };
        team.tasks.set(id, t);
        return send(201, { task: shape(t) });
      }
      return send(404, { error: 'not_found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { team, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
const wait = (ms = 450) => new Promise((r) => setTimeout(r, ms));
const mirrorOf = async (b, teamId) => (await b.app.taskStore.list({ includeArchived: true })).find((t) => t.org?.id === teamId);

test('tokens: per person, plus a shorthand for the default person', () => {
  const m = parseOrgTokens('maya|abc,avi|d|e', 'zzz', 'me');
  assert.deepEqual([...m.entries()], [['me', 'zzz'], ['maya', 'abc'], ['avi', 'd|e']]);
});

test('without a team board nothing happens and the dashboard says so', async () => {
  const b = await boot();
  assert.equal((await b.call('/api/bootstrap')).body.org.enabled, false);
  assert.equal((await b.call('/api/org')).body.enabled, false);
  await b.close();
});

test('team tasks are mirrored into the work space; the team board wins on what it changed', async () => {
  const f = await fakeTeam();
  f.team.tasks.set(7, { id: 7, title: 'דוח רבעוני', description: 'פרטים', due: '2026-11-02', status: 'open', rev: 1 });
  f.team.tasks.set(8, { id: 8, title: 'בקשה ממאיה', description: '', due: null, status: 'pending', rev: 1 });
  const b = await boot({ orgOptions: { url: f.url, tokens: new Map([['me', TOKEN]]), interval: 1e9 } });
  await b.app.orgSync.pull('me');
  const t7 = await mirrorOf(b, 7); const t8 = await mirrorOf(b, 8);
  assert.equal(t7.title, 'דוח רבעוני'); assert.equal(t7.deadline, '2026-11-02'); assert.equal(t7.notes, 'פרטים');
  assert.equal(t7.status, 'next'); assert.equal(t7.org.role, 'responsible');
  assert.equal(t8.status, 'inbox', 'waiting for my acceptance lands in the inbox');
  f.team.tasks.get(7).status = 'doing'; f.team.tasks.get(7).title = 'דוח רבעוני מעודכן';
  await b.app.orgSync.pull('me');
  const again = await mirrorOf(b, 7);
  assert.equal(again.status, 'doing'); assert.equal(again.title, 'דוח רבעוני מעודכן');
  assert.equal((await b.app.taskStore.list({ includeArchived: true })).filter((t) => t.org?.id === 7).length, 1, 'no duplicates');
  // the agent sees it marked
  const line = await b.call('/mcp', { method: 'POST', actor: 'agent', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_tasks', arguments: { ids: [Number(again.id)] } } } });
  assert.match(JSON.stringify(line.body), /🏢 ארגוני/);
  await b.close(); await f.close();
});

test('local edits go back; a refused edit is put back with the reason in the activity log', async () => {
  const f = await fakeTeam();
  f.team.tasks.set(7, { id: 7, title: 'דוח', description: '', due: '2026-11-02', status: 'open', rev: 1 });
  const b = await boot({ orgOptions: { url: f.url, tokens: new Map([['me', TOKEN]]), interval: 1e9 } });
  await b.app.orgSync.pull('me');
  const local = await mirrorOf(b, 7);
  // status → doing
  await b.call(`/api/tasks/${local.id}`, { method: 'PATCH', body: { status: 'doing' } });
  await wait();
  assert.equal(f.team.tasks.get(7).status, 'doing');
  // due date without a reason → refused and reverted
  await b.call(`/api/tasks/${local.id}`, { method: 'PATCH', body: { deadline: '2026-11-09' } });
  await wait();
  assert.equal(f.team.tasks.get(7).due, '2026-11-02');
  assert.equal((await mirrorOf(b, 7)).deadline, '2026-11-02', 'put back');
  const act = (await b.call(`/api/activity?task=${local.id}`)).body;
  assert.match(JSON.stringify(act), /דורשת סיבה/);
  // with a reason (dashboard field org_reason) → accepted, reason forwarded
  await b.call(`/api/tasks/${local.id}`, { method: 'PATCH', body: { deadline: '2026-11-09', org_reason: 'מחכה לנתונים' } });
  await wait();
  assert.equal(f.team.tasks.get(7).due, '2026-11-09');
  assert.equal(f.team.requests.filter((r) => r.method === 'PATCH').at(-1).input.reason, 'מחכה לנתונים');
  // through the agent, with `reason`
  await b.call('/mcp', { method: 'POST', actor: 'agent', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_tasks', arguments: { updates: [{ id: Number(local.id), deadline: '2026-11-16', reason: 'הלקוח ביקש' }] } } } });
  await wait();
  assert.equal(f.team.tasks.get(7).due, '2026-11-16');
  // no permission for the title → refused, reverted
  f.team.deny.add('title');
  await b.call(`/api/tasks/${local.id}`, { method: 'PATCH', body: { title: 'שם אחר' } });
  await wait();
  assert.equal((await mirrorOf(b, 7)).title, 'דוח');
  await b.close(); await f.close();
});

test('a task that leaves my set is archived here; exposing a personal task creates and links a team task', async () => {
  const f = await fakeTeam();
  f.team.tasks.set(7, { id: 7, title: 'הועבר למישהו אחר', due: null, status: 'open', rev: 1 });
  const b = await boot({ orgOptions: { url: f.url, tokens: new Map([['me', TOKEN]]), interval: 1e9 } });
  await b.app.orgSync.pull('me');
  f.team.tasks.delete(7); f.team.gone = [7];
  await b.app.orgSync.pull('me');
  const gone = await mirrorOf(b, 7);
  assert.equal(gone.archived, true); assert.equal(gone.org.gone, true);

  const mine = (await b.call('/api/tasks', { method: 'POST', body: { title: 'רעיון לשיפור', notes: 'הסבר', deadline: '2026-12-01' } })).body;
  const r = await b.call(`/api/tasks/${mine.id}/org`, { method: 'POST', body: {} });
  assert.equal(r.status, 200);
  const created = f.team.requests.find((x) => x.method === 'POST');
  assert.deepEqual(created.input, { title: 'רעיון לשיפור', description: 'הסבר', due: '2026-12-01', origin: 'personal' });
  assert.equal(r.body.task.org.id, r.body.team.id);
  assert.equal((await b.call(`/api/tasks/${mine.id}/org`, { method: 'POST', body: {} })).status, 409, 'only once');
  await b.close(); await f.close();
});

test('the token never reaches the browser', async () => {
  const f = await fakeTeam();
  const b = await boot({ orgOptions: { url: f.url, tokens: new Map([['me', TOKEN]]), interval: 1e9 } });
  const boot1 = await b.call('/api/bootstrap');
  assert.ok(!JSON.stringify(boot1.body).includes(TOKEN));
  assert.ok(!JSON.stringify((await b.call('/api/org')).body).includes(TOKEN));
  assert.ok(AGENT_TOKEN);
  await b.close(); await f.close();
});
