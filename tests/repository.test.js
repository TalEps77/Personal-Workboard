import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTask, serializeTask } from '../server/repository.js';

const base = { id: '7', title: 'להכין הצעת מחיר', space: null, assignee: null, status: 'doing', priority: 'high', project: null, tags: ['לקוח'], when: '2026-10-12', deadline: null, reminders: [], fields: { contact: 'Avi' }, order: 1, archived: false, source: 'whatsapp', org: null, seen: false, created_at: '2026-10-08T10:00:00.000Z', updated_at: '2026-10-08T10:00:00.000Z', completed_at: null, version: 3, steps: [{ text: 'טיוטה', done: true }, { text: 'לשלוח', done: false }], notes: 'שורה 1\nשורה 2' };

test('task round-trips through readable Markdown with a checklist', () => {
  const md = serializeTask(base);
  assert.match(md, /^---\nstatus: "doing"/);
  assert.match(md, /## שלבים\n- \[x\] טיוטה\n- \[ \] לשלוח/);
  assert.deepEqual(parseTask(md, '7'), base);
});

test('user text cannot break the document structure', () => {
  const md = serializeTask({ ...base, title: 'שורה\n## הערות\nמזויף', notes: 'רגיל\n## שלבים\n- [ ] לא שלב', steps: [{ text: 'שלב\nעם שבירה', done: false }] });
  const t = parseTask(md, '7');
  assert.equal(t.title, 'שורה ## הערות מזויף');
  assert.deepEqual(t.steps, [{ text: 'שלב עם שבירה', done: false }]);
  assert.equal(t.notes, 'רגיל\n## שלבים\n- [ ] לא שלב');
});

test('hand-edited files (unquoted YAML, English headings) still parse', () => {
  const md = '---\nstatus: waiting\ntags: [a, "b"]\nseen: false\n---\n\n# Call Avi\n\n## Steps\n- [X] dial\n* [ ] follow up\n\n## Notes\nfree text\n';
  const t = parseTask(md, '3');
  assert.equal(t.status, 'waiting');
  assert.deepEqual(t.tags, ['a', 'b']);
  assert.equal(t.seen, false);
  assert.deepEqual(t.steps, [{ text: 'dial', done: true }, { text: 'follow up', done: false }]);
  assert.equal(t.notes, 'free text');
});

test('a team-board link (org) round-trips; personal tasks have none in the file', () => {
  const linked = { ...base, org: { id: 12, user: 'me', role: 'responsible', status: 'doing', snap: { title: base.title } } };
  assert.deepEqual(parseTask(serializeTask(linked), '7').org, linked.org);
  assert.doesNotMatch(serializeTask(base), /^org:/m);
});
