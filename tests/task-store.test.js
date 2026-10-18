import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boot } from './helpers.js';

test('agent-created tasks are flagged as new from WhatsApp; ids are sequential', async () => {
  const b = await boot();
  try {
    const a = (await b.call('/api/tasks', { method: 'POST', body: { title: 'א' }, actor: 'agent' })).body;
    const d = (await b.call('/api/tasks', { method: 'POST', body: { title: 'ב' } })).body;
    assert.deepEqual([a.id, a.source, a.seen, a.status, a.priority], ['1', 'whatsapp', false, 'next', 'normal']);
    assert.deepEqual([d.id, d.source, d.seen], ['2', 'dashboard', true]);
    assert.match(await readFile(join(b.root, 'data/tasks/1.md'), 'utf8'), /# א/);
  } finally { await b.close(); }
});

test('validation errors are readable and nothing is written', async () => {
  const b = await boot();
  try {
    for (const body of [{ title: '' }, { title: 'x', status: 'nope' }, { title: 'x', project: 'ghost' }, { title: 'x', deadline: '12/10' }, { title: 'x', reminders: [{ at: 'soon' }] }]) {
      const r = await b.call('/api/tasks', { method: 'POST', body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.body.error);
    }
    assert.equal((await b.call('/api/tasks')).body.items.length, 0);
  } finally { await b.close(); }
});

test('steps by position, completion timestamps, and undo of an agent change', async () => {
  const b = await boot();
  try {
    await b.call('/api/tasks', { method: 'POST', body: { title: 'מצגת', steps: ['א', 'ב'] } });
    await b.call('/api/tasks/1/steps', { method: 'POST', body: { texts: ['ג'] }, actor: 'agent' });
    let t = (await b.call('/api/tasks/1/steps/2', { method: 'PATCH', body: { done: true }, actor: 'agent' })).body;
    assert.deepEqual(t.steps.map((s) => [s.text, s.done]), [['א', false], ['ב', true], ['ג', false]]);
    assert.equal((await b.call('/api/tasks/1/steps/9', { method: 'PATCH', body: { done: true } })).status, 400);

    t = (await b.call('/api/tasks/1', { method: 'PATCH', body: { status: 'done' }, actor: 'agent' })).body;
    assert.ok(t.completed_at);
    const [last] = (await b.call('/api/activity?limit=1')).body.items;
    assert.deepEqual([last.actor, last.summary, last.undoable], ['agent', 'הבא בתור → בוצע', true]);
    t = (await b.call(`/api/activity/${last.id}/undo`, { method: 'POST', body: {} })).body;
    assert.equal(t.status, 'next');
    assert.equal(t.steps.length, 3);
  } finally { await b.close(); }
});

test('delete moves to trash and can be undone; ids are never reused', async () => {
  const b = await boot();
  try {
    await b.call('/api/tasks', { method: 'POST', body: { title: 'למחוק' } });
    await b.call('/api/tasks/1', { method: 'DELETE' });
    assert.equal((await b.call('/api/tasks/1')).status, 404);
    assert.equal((await b.call('/api/tasks', { method: 'POST', body: { title: 'חדש' } })).body.id, '2');
    const del = (await b.call('/api/activity?task=1')).body.items.find((a) => a.action === 'delete');
    await b.call(`/api/activity/${del.id}/undo`, { method: 'POST', body: {} });
    assert.equal((await b.call('/api/tasks/1')).body.title, 'למחוק');
  } finally { await b.close(); }
});
