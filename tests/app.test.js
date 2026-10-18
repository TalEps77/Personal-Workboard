import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

test('mutations require JSON (no cross-site form posts) and static files cannot escape public/', async () => {
  const b = await boot();
  try {
    const form = await fetch(`${b.base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"title":"csrf"}' });
    assert.equal(form.status, 415);
    assert.equal((await fetch(`${b.base}/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`${b.base}/`)).status, 200);
  } finally { await b.close(); }
});

test('task filters used by the agent', async () => {
  const b = await boot();
  try {
    await b.call('/api/schema', { method: 'PATCH', body: { projects: [{ id: 'q', name: 'רבעון' }] } });
    await b.call('/api/tasks', { method: 'POST', body: { title: 'אחת', status: 'doing', project: 'q', tags: ['כסף'] } });
    await b.call('/api/tasks', { method: 'POST', body: { title: 'שתיים', status: 'done' } });
    await b.call('/api/tasks', { method: 'POST', body: { title: 'שלוש', deadline: '2000-01-01' } });
    const ids = async (q) => (await b.call(`/api/tasks?${q}`)).body.items.map((t) => t.title);
    assert.deepEqual(await ids('open=1'), ['אחת', 'שלוש']);
    assert.deepEqual(await ids('project=q'), ['אחת']);
    assert.deepEqual(await ids('tag=כסף'), ['אחת']);
    assert.deepEqual(await ids('due=overdue'), ['שלוש']);
    assert.deepEqual(await ids(`q=${encodeURIComponent('שתי')}`), ['שתיים']);
    const summary = (await b.call('/api/summary')).body;
    assert.equal(summary.counts.overdue, 1);
    assert.match(summary.text, /באיחור/);
  } finally { await b.close(); }
});

test('schema edits are validated; invalid structure is rejected and the old one kept', async () => {
  const b = await boot();
  try {
    const schema = (await b.call('/api/schema')).body;
    const bad = await b.call('/api/schema', { method: 'PUT', body: { ...schema, statuses: schema.statuses.filter((s) => s.category !== 'done') } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /done/);
    const ok = await b.call('/api/schema', { method: 'PUT', body: { ...schema, statuses: [...schema.statuses, { id: 'review', label: 'בבדיקה', category: 'active', color: 'pink' }] }, actor: 'agent' });
    assert.equal(ok.status, 200);
    assert.equal((await b.call('/api/tasks', { method: 'POST', body: { title: 'x', status: 'review' } })).status, 201);
    const field = await b.call('/api/schema', { method: 'PATCH', body: { fields: [{ id: 'kind', label: 'סוג', type: 'select' }] } });
    assert.equal(field.status, 400);
  } finally { await b.close(); }
});

test('live events stream task changes with the acting agent', async () => {
  const b = await boot();
  try {
    const controller = new AbortController();
    const res = await fetch(`${b.base}/api/events`, { signal: controller.signal, headers: { cookie: `wb_session=${b.session}` } });
    const reader = res.body.getReader();
    await reader.read(); // hello
    await b.call('/api/tasks', { method: 'POST', body: { title: 'חי' }, actor: 'agent' });
    let text = '';
    while (!text.includes('"type":"task"')) text += new TextDecoder().decode((await reader.read()).value);
    const event = JSON.parse(text.split('data: ').pop());
    assert.equal(event.task.title, 'חי');
    assert.equal(event.activity.actor, 'agent');
    controller.abort();
  } finally { await b.close(); }
});

test('projects carry goals: goal text, due date and dated milestones (validated)', async () => {
  const b = await boot();
  try {
    const ok = await b.call('/api/schema', { method: 'PATCH', body: { projects: [{ id: 'website', name: 'website', goal: 'דשבורד לקוחות באוויר', due: '2026-11-30', aliases: ['אתר'], milestones: [{ title: 'אפיון', date: '2026-10-20' }, { title: 'פיילוט', date: '2026-10-15', done: true }] }] } });
    assert.equal(ok.status, 200);
    const p = ok.body.projects[0];
    assert.deepEqual(p.milestones.map((m) => m.title), ['פיילוט', 'אפיון'], 'sorted by date');
    assert.match(p.milestones[0].id, /^m/);
    assert.equal((await b.call('/api/schema', { method: 'PATCH', body: { projects: [{ id: 'x', name: 'x', due: 'next week' }] } })).status, 400);
  } finally { await b.close(); }
});
