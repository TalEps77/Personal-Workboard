import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { appendLine, createLock, readLines, writeAtomic } from './fs-util.js';
import { oneLine, parseTask, serializeTask } from './repository.js';
import { local, zoned } from './time.js';
import { isRealDate, isRealTime } from './dates.js';

export const REPEATS = ['daily', 'weekdays', 'weekly', 'monthly'];
// Fields a person or the agent edits; activity entries store the previous values of whichever of these changed.
const TRACKED = ['space', 'assignee', 'title', 'status', 'priority', 'project', 'tags', 'when', 'deadline', 'steps', 'notes', 'reminders', 'fields', 'archived', 'order'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RID_RE = /^r[a-z0-9]{1,12}$/;
const ACTIVITY_MAX_BYTES = 2_000_000;
const rid = () => `r${Math.random().toString(36).slice(2, 8)}`;
const clean = (v) => (v === '' || v === undefined ? null : v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const withoutRev = ({ rev, degraded, ...rest }) => rest;

/** Task ids are positive integers. Malformed → 400 invalid_id; well-formed but out of range → 404 like any missing task. */
export function validateId(id) {
  if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) throw Object.assign(new Error(`Invalid task id "${id}" (use the number, e.g. 12)`), { status: 400, code: 'invalid_id' });
  if (id.length > 7) throw Object.assign(new Error(`Task ${id} not found`), { status: 404, code: 'not_found' });
  return id;
}

function bad(message) { return Object.assign(new Error(message), { status: 400 }); }
function notFound(message) { return Object.assign(new Error(message), { status: 404, code: 'not_found' }); }
function conflict(message) { return Object.assign(new Error(message), { status: 409, code: 'conflict' }); }
// What a person means by a reminder (ignores delivery bookkeeping the scheduler updates).
const intent = (key, value) => (key === 'reminders' && Array.isArray(value) ? value.map((r) => ({ id: r.id, note: r.note, repeat: r.repeat, nag: r.nag, anchor: r.anchor })) : value);

function normalizeDate(value, name) {
  const v = clean(value);
  if (v === null) return null;
  if (typeof v !== 'string' || !DATE_RE.test(v) || !isRealDate(...v.split('-').map(Number))) throw bad(`${name} must be a real date, YYYY-MM-DD (got "${v}")`);
  return v;
}

function parseAt(value) {
  if (typeof value !== 'string') throw bad('reminder.at must be a string');
  if (DATE_RE.test(value)) throw bad('reminder.at needs a time too, e.g. 2026-10-12T09:00');
  // "2026-10-12T09:00" (no offset) means local wall-clock time (instance time zone) — the agent shouldn't have to know about DST.
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/);
  if (m && (!isRealDate(+m[1], +m[2], +m[3]) || !isRealTime(+m[4], +m[5]))) throw bad(`reminder.at "${value}" is not a real date/time`);
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m && iso && (!isRealDate(+iso[1], +iso[2], +iso[3]) || !isRealTime(+iso[4], +iso[5]))) throw bad(`reminder.at "${value}" is not a real date/time`);
  const t = m ? zoned(+m[1], +m[2], +m[3], +m[4], +m[5]) : Date.parse(value);
  if (Number.isNaN(t)) throw bad('reminder.at must be a date-time, e.g. 2026-10-12T09:00 (local time) or full ISO');
  return new Date(t).toISOString();
}

/**
 * Validates a reminder. `existing` keeps delivery bookkeeping (sent_count, done…) unless the input changes it,
 * so editing a note never re-arms a reminder that already fired; only a new `at` or explicit `done:false` does.
 */
export function normalizeReminder(input, existing = {}) {
  const r = {
    id: existing.id || null, at: existing.at || null, anchor: existing.anchor || null, note: existing.note || '',
    repeat: existing.repeat || null, nag: existing.nag || null, sent_count: existing.sent_count || 0,
    last_sent_at: existing.last_sent_at || null, last_error: existing.last_error || null, retry_at: existing.retry_at || null,
    attempts: existing.attempts || 0, done: existing.done === true, to: existing.to || null,
    // Delivery bookkeeping survives content edits (a note change must not reset retry identity).
    fail_seq: existing.fail_seq || 0, delivery_failed: existing.delivery_failed === true,
  };
  if (!r.id) {
    if (input.id !== undefined && !RID_RE.test(input.id)) throw bad('reminder.id must look like r + letters/digits (or omit it)');
    r.id = input.id || rid();
  }
  if (input.at !== undefined) {
    const at = parseAt(input.at);
    if (at !== existing.at) {
      r.at = at;
      // The wall-clock anchor keeps repeats on their day/time (e.g. the 31st, or 02:30 across DST).
      const l = local(at);
      r.anchor = `${l.date}T${l.time}`;
      r.retry_at = null; r.attempts = 0; r.last_error = null; r.fail_seq = 0; r.delivery_failed = false;
      if (input.done === undefined) r.done = false;
    }
  }
  if (!r.at) throw bad('reminder.at is required');
  if (!r.anchor) { const l = local(r.at); r.anchor = `${l.date}T${l.time}`; }
  if (input.note !== undefined) r.note = oneLine(input.note);
  if (input.to !== undefined) {
    r.to = clean(input.to);
    if (r.to !== null && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(r.to)) throw bad('reminder.to must be a person id');
  }
  if (input.repeat !== undefined) {
    r.repeat = clean(input.repeat);
    if (r.repeat !== null && !REPEATS.includes(r.repeat)) throw bad(`reminder.repeat must be one of ${REPEATS.join(', ')} or null`);
  }
  if (input.nag !== undefined) {
    r.nag = clean(input.nag) === null ? null : Number(input.nag);
    if (r.nag !== null && !(Number.isInteger(r.nag) && r.nag >= 5 && r.nag <= 1440)) throw bad('reminder.nag must be minutes between 5 and 1440, or null');
  }
  if (r.nag && r.repeat) throw bad('reminder: use either repeat or nag, not both');
  if (input.done !== undefined) {
    r.done = Boolean(input.done);
    if (!r.done) { r.retry_at = null; r.attempts = 0; r.last_error = null; }
  }
  return r;
}

/**
 * Validates against the live schema. Values that did not change are tolerated even if the schema no longer
 * knows them (e.g. a status removed by hand) so such a task stays editable.
 */
function normalize(task, schema, base, people = null) {
  const unchanged = (key) => base && same(base[key], task[key]);
  task.space = clean(task.space);
  if (people && task.space !== null && !people.spaces.some((s) => s.id === task.space) && !unchanged('space')) throw bad(`Unknown space "${task.space}". Valid: ${people.spaces.map((s) => s.id).join(', ')}`);
  task.assignee = clean(task.assignee);
  if (people && task.assignee !== null && task.assignee !== 'both' && !people.users.some((u) => u.id === task.assignee) && !unchanged('assignee')) throw bad(`Unknown person "${task.assignee}" (use ${people.users.map((u) => u.id).join(', ')} or both)`);
  let status = schema.statuses.find((s) => s.id === task.status);
  if (!status) {
    if (!unchanged('status')) throw bad(`Unknown status "${task.status}". Valid: ${schema.statuses.map((s) => s.id).join(', ')}`);
    status = { id: task.status, category: 'todo' };
  }
  if (!task.priority) task.priority = schema.defaultPriority;
  if (!schema.priorities.some((p) => p.id === task.priority) && !unchanged('priority')) throw bad(`Unknown priority "${task.priority}". Valid: ${schema.priorities.map((p) => p.id).join(', ')}`);
  task.project = clean(task.project);
  if (task.project !== null && !schema.projects.some((p) => p.id === task.project) && !unchanged('project')) throw bad(`Unknown project "${task.project}". Create it first via PATCH /api/schema`);
  task.title = oneLine(task.title);
  if (!task.title) throw bad('title is required');
  task.tags = [...new Set((Array.isArray(task.tags) ? task.tags : String(task.tags || '').split(',')).map((t) => oneLine(t).replace(/^#/, '')).filter(Boolean))];
  task.when = normalizeDate(task.when, 'when');
  task.deadline = normalizeDate(task.deadline, 'deadline');
  if (!Array.isArray(task.steps)) throw bad('steps must be an array');
  task.steps = task.steps.map((s) => (typeof s === 'string' ? { text: oneLine(s), done: false } : { text: oneLine(s?.text), done: Boolean(s?.done) })).filter((s) => s.text);
  task.notes = String(task.notes ?? '');
  if (!task.fields || typeof task.fields !== 'object' || Array.isArray(task.fields)) throw bad('fields must be an object');
  task.fields = { ...task.fields };
  for (const [key, value] of Object.entries(task.fields)) {
    if (value === null || value === '') { delete task.fields[key]; continue; }
    const def = schema.fields.find((f) => f.id === key);
    if (def?.type === 'url' && !/^https?:\/\//i.test(String(value))) throw bad(`field "${def.label}" must be an http(s) link`);
  }
  task.order = Number.isFinite(Number(task.order)) ? Number(task.order) : 0;
  task.archived = Boolean(task.archived);
  const ids = new Set();
  for (const r of task.reminders) { if (ids.has(r.id)) throw bad(`duplicate reminder id ${r.id}`); ids.add(r.id); }
  return status;
}

export function createTaskStore(root, { schemaStore, onChange = () => {}, lock = createLock(), people = null } = {}) {
  const dataDir = join(root, 'data');
  const directory = join(dataDir, 'tasks');
  const trash = join(dataDir, 'trash');
  const activityPath = join(dataDir, 'runtime', 'activity.jsonl');
  const filename = (id) => join(directory, `${validateId(id)}.md`);

  async function readRaw(id) {
    try { return await readFile(filename(id), 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') throw notFound(`Task ${id} not found`);
      throw error;
    }
  }
  const read = async (id) => parseTask(await readRaw(id), id);

  async function nextId() {
    const names = [...await readdir(directory).catch(() => []), ...await readdir(trash).catch(() => [])];
    const max = names.reduce((m, n) => Math.max(m, Number.parseInt(n, 10) || 0), 0);
    return String(max + 1);
  }

  async function log(entry) {
    try {
      // Keep the live log small; one previous generation stays next to it.
      if ((await stat(activityPath)).size > ACTIVITY_MAX_BYTES) await rename(activityPath, `${activityPath}.1`);
    } catch { /* no log yet */ }
    const record = { id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, at: new Date().toISOString(), ...entry };
    await appendLine(activityPath, record);
    return record;
  }
  const publicEntry = ({ before, ...rest }) => ({ ...rest, undoable: before !== undefined });

  // Every save goes through here (always inside the lock), so `version` increases by one per write.
  const save = (task) => { task.version = (task.version || 0) + 1; return writeAtomic(filename(task.id), serializeTask(task)); };

  async function write(task, { actor, action, summary, before, after, onActivity }) {
    await save(task);
    const entry = await log({ actor, action, task: task.id, title: task.title, ...(task.space && { space: task.space }), summary, before, after });
    onActivity?.(publicEntry(entry)); // lets a caller report exactly its own change (and undo id)
    onChange({ type: 'task', task, activity: publicEntry(entry) });
    return task;
  }

  /** Applies `changes` to a task (or a blank one), validating against the live schema. */
  async function apply(base, changes, now, { isNew = false } = {}) {
    const schema = await schemaStore.get();
    const task = { ...base };
    const editable = ['space', 'assignee', 'title', 'status', 'priority', 'project', 'tags', 'when', 'deadline', 'steps', 'notes', 'order', 'archived', 'seen', 'source', 'org'];
    for (const key of editable) if (changes[key] !== undefined) task[key] = changes[key];
    if (changes.fields !== undefined) {
      if (!changes.fields || typeof changes.fields !== 'object' || Array.isArray(changes.fields)) throw bad('fields must be an object');
      task.fields = { ...task.fields, ...changes.fields };
    }
    if (changes.reminders !== undefined) {
      if (!Array.isArray(changes.reminders)) throw bad('reminders must be an array');
      task.reminders = changes.reminders.map((r) => normalizeReminder(r || {}, r?.id ? base.reminders.find((old) => old.id === r.id) : undefined));
    }
    const status = normalize(task, schema, isNew ? null : base, people);
    const wasDone = schema.statuses.find((s) => s.id === base.status)?.category === 'done';
    task.completed_at = status.category === 'done' ? (wasDone && base.completed_at) || now : null;
    task.updated_at = now;
    return task;
  }

  function diff(before, after) {
    const out = {};
    for (const key of TRACKED) if (!same(before[key], after[key])) out[key] = before[key];
    return out;
  }

  // Human-readable, in the board's own words, with absolute dates (the line is read later — "מחר" would rot).
  const DOW = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
  const day = (d) => (d ? `${DOW[new Date(`${d}T12:00:00Z`).getUTCDay()]} ${Number(d.slice(8))}.${Number(d.slice(5, 7))}` : 'ללא');
  function describe(before, after, schema = { statuses: [], priorities: [], projects: [] }) {
    const parts = [];
    const label = (list, id, key = 'label') => list.find((x) => x.id === id)?.[key] || id || 'ללא';
    const spaceName = (id) => people?.spaces.find((x) => x.id === (id || people.defaultSpace))?.label || id || 'עבודה';
    if ((before.space || null) !== (after.space || null)) parts.push(`הועברה: ${spaceName(before.space)} → ${spaceName(after.space)}`);
    if ((before.assignee || null) !== (after.assignee || null)) parts.push(`על: ${after.assignee === 'both' ? 'שנינו' : people?.users.find((u) => u.id === after.assignee)?.name || after.assignee || 'אף אחד'}`);
    if (before.status !== after.status) parts.push(`${label(schema.statuses, before.status)} → ${label(schema.statuses, after.status)}`);
    if (before.title !== after.title) parts.push('כותרת');
    if (before.priority !== after.priority) parts.push(`עדיפות: ${label(schema.priorities, after.priority)}`);
    if (before.project !== after.project) parts.push(`פרויקט: ${label(schema.projects, after.project, 'name')}`);
    if (before.when !== after.when) parts.push(`תאריך עבודה: ${day(before.when)} → ${day(after.when)}`);
    if (before.deadline !== after.deadline) parts.push(`דדליין: ${day(before.deadline)} → ${day(after.deadline)}`);
    const doneBefore = before.steps.filter((s) => s.done).length; const doneAfter = after.steps.filter((s) => s.done).length;
    if (before.steps.length !== after.steps.length) parts.push(`שלבים (${after.steps.length})`);
    else if (doneBefore !== doneAfter) parts.push(`שלבים ${doneAfter}/${after.steps.length}`);
    else if (!same(before.steps, after.steps)) parts.push('שלבים');
    if (before.notes !== after.notes) parts.push('הערות');
    if (!same(before.reminders, after.reminders)) parts.push('תזכורות');
    if (!same(before.tags, after.tags)) parts.push('תגיות');
    if (!same(before.fields, after.fields)) parts.push('שדות');
    if (before.archived !== after.archived) parts.push(after.archived ? 'הועברה לארכיון' : 'הוחזרה מהארכיון');
    if (!parts.length && before.order !== after.order) parts.push('סדר');
    return parts.join(' · ');
  }

  /** Core read-modify-write; always runs inside the lock. `changes` may be a function of the current task. */
  async function updateLocked(id, changes, { actor = 'dashboard', now = new Date().toISOString(), action = 'update', summaryPrefix = '', onActivity } = {}) {
    const before = await read(id);
    const resolved = typeof changes === 'function' ? await changes(before) : changes;
    const after = await apply(before, resolved || {}, now);
    const changed = diff(before, after);
    if (!Object.keys(changed).length) {
      // Only bookkeeping (e.g. `seen`) changed: save quietly, no activity line.
      if (before.seen !== after.seen || before.source !== after.source || !same(before.org, after.org)) {
        await save(after);
        onChange({ type: 'task', task: after });
      }
      return after;
    }
    const afterValues = Object.fromEntries(Object.keys(changed).map((k) => [k, after[k]]));
    return write(after, { actor, action, summary: `${summaryPrefix}${describe(before, after, await schemaStore.get())}`, before: changed, after: afterValues, onActivity });
  }

  const usage = async () => {
    const tasks = await store.list({ includeArchived: true });
    const count = (key) => tasks.reduce((m, t) => (t[key] ? m.set(t[key], (m.get(t[key]) || 0) + 1) : m), new Map());
    return { statuses: count('status'), projects: count('project') };
  };

  function describeSchema(before, after) {
    const parts = [];
    const ids = (xs) => xs.map((x) => x.id).join(',');
    const named = { statuses: 'סטטוסים', projects: 'פרויקטים', fields: 'שדות', views: 'תצוגות', priorities: 'עדיפויות', notifications: 'התראות', tags: 'תגיות', title: 'שם הלוח', publicUrl: 'כתובת' };
    for (const [key, label] of Object.entries(named)) if (!same(before[key], after[key])) parts.push(Array.isArray(after[key]) && ids(before[key] || []) !== ids(after[key]) ? `${label} (${(after[key] || []).length})` : label);
    return `מבנה: ${parts.join(' · ') || 'ללא שינוי'}`;
  }

  const undoHooks = {};
  const store = {
    /** For sibling stores: write an activity line (call inside the shared lock) and announce it. */
    async logActivity(entry) {
      const logged = await log(entry);
      onChange({ type: 'activity', activity: publicEntry(logged) });
      return publicEntry(logged);
    },
    registerUndo(action, fn) { undoHooks[action] = fn; },
    usage,

    /** Structure edits go through here so they share the task lock and land in the (undoable) activity log. */
    changeSchema(kind, input, { actor = 'dashboard' } = {}) {
      return lock(async () => {
        const { before, after } = await schemaStore.saveUnlocked(kind, input);
        const entry = await log({ actor, action: 'schema', task: null, title: 'מבנה הלוח', summary: describeSchema(before, after), before: { schema: before }, after: { rev: after.rev, schema: after } });
        onChange({ type: 'activity', activity: publicEntry(entry) });
        return after;
      });
    },

    async list({ includeArchived = false } = {}) {
      await mkdir(directory, { recursive: true });
      const names = (await readdir(directory)).filter((n) => /^\d+\.md$/.test(n));
      const tasks = await Promise.all(names.map(async (n) => {
        const id = n.slice(0, -3);
        try { return parseTask(await readFile(join(directory, n), 'utf8'), id); } catch { return null; }
      }));
      return tasks.filter((t) => t && (includeArchived || !t.archived)).sort((a, b) => Number(a.id) - Number(b.id));
    },

    get: read,

    create(input = {}, { actor = 'dashboard', now = new Date().toISOString() } = {}) {
      return lock(async () => {
        await mkdir(directory, { recursive: true });
        const schema = await schemaStore.get();
        const fromAgent = !String(actor).startsWith('dashboard');
        const blank = { org: null, space: null, assignee: null, title: '', status: schema.defaultStatus, priority: null, project: null, tags: [], when: null, deadline: null, reminders: [], fields: {}, order: 0, archived: false, source: fromAgent ? 'whatsapp' : 'dashboard', seen: !fromAgent, created_at: now, completed_at: null, steps: [], notes: '' };
        const task = await apply(blank, { ...input, order: input.order ?? Date.now() }, now, { isNew: true });
        task.id = await nextId();
        task.created_at = now;
        return write(task, { actor, action: 'create', summary: 'נוצרה', before: null });
      });
    },

    update(id, changes = {}, opts = {}) {
      return lock(() => updateLocked(id, changes, opts));
    },

    /** Convenience for the agent: mutate steps by 1-based position. */
    step(id, op, opts = {}) {
      return lock(() => updateLocked(id, (task) => {
        const steps = task.steps.map((s) => ({ ...s }));
        if (op.add) [].concat(op.add).forEach((text) => steps.push({ text, done: false }));
        if (op.index !== undefined) {
          const i = Number(op.index) - 1;
          if (!steps[i]) throw bad(`Step ${op.index} does not exist (task has ${steps.length})`);
          if (op.remove) steps.splice(i, 1);
          else {
            if (op.done !== undefined) steps[i].done = Boolean(op.done);
            if (op.text !== undefined) steps[i].text = op.text;
          }
        }
        return { steps };
      }, opts));
    },

    addReminder(id, input, opts = {}) {
      return lock(async () => {
        let created;
        const task = await updateLocked(id, (t) => {
          created = normalizeReminder(input || {});
          if (t.reminders.some((r) => r.id === created.id)) throw bad(`reminder id ${created.id} already exists`);
          return { reminders: [...t.reminders, created] };
        }, opts);
        return { ...task, reminder: task.reminders.find((r) => r.id === created.id) };
      });
    },

    /** `change`: null (delete), an input object, or a function (current reminder) => input object. */
    changeReminder(id, reminderId, change, opts = {}) {
      return lock(() => updateLocked(id, (task) => {
        const current = task.reminders.find((r) => r.id === reminderId);
        if (!current) throw notFound(`Reminder ${reminderId} not found`);
        if (change === null) return { reminders: task.reminders.filter((r) => r.id !== reminderId) };
        const input = typeof change === 'function' ? change(current) : change;
        const next = normalizeReminder({ ...input, id: undefined }, current);
        return { reminders: task.reminders.map((r) => (r.id === reminderId ? next : r)) };
      }, opts));
    },

    /**
     * Scheduler bookkeeping, compare-and-set: only applies if the reminder still has the `at`/`done` the scheduler
     * saw, so a snooze or edit made while a message was being delivered is never overwritten.
     */
    markReminder(id, reminderId, patch, expect) {
      return lock(async () => {
        let task;
        try { task = await read(id); } catch { return null; }
        const r = task.reminders.find((x) => x.id === reminderId);
        const norm = (k, v) => (k === 'done' ? Boolean(v) : v ?? null);
        if (!r || (expect && Object.entries(expect).some(([k, v]) => norm(k, r[k]) !== norm(k, v)))) return null;
        task.reminders = task.reminders.map((x) => (x.id === reminderId ? { ...x, ...patch } : x));
        await save(task);
        onChange({ type: 'task', task });
        return task;
      });
    },

    remove(id, { actor = 'dashboard' } = {}) {
      return lock(async () => {
        const raw = await readRaw(id);
        const task = parseTask(raw, id);
        await mkdir(trash, { recursive: true });
        await rename(filename(id), join(trash, `${id}.md`));
        const entry = await log({ actor, action: 'delete', task: id, title: task.title, ...(task.space && { space: task.space }), summary: 'נמחקה', before: raw });
        onChange({ type: 'delete', id, space: task.space, activity: publicEntry(entry) });
        return { ok: true, id };
      });
    },

    async activity({ limit = 50, task, filter = null } = {}) {
      const all = await readLines(activityPath);
      return all.filter((a) => (!task || a.task === task) && (!filter || filter(a))).slice(-limit).reverse().map(publicEntry);
    },

    async activityEntry(id) { return (await readLines(activityPath)).find((a) => a.id === id) || null; },

    /**
     * Reverts exactly what one activity entry did — only the fields it changed, so later edits survive.
     * The revert is itself an entry, so it can be undone again (redo).
     */
    undo(activityId, { actor = 'dashboard', now = new Date().toISOString() } = {}) {
      return lock(async () => {
        const entry = (await readLines(activityPath)).find((a) => a.id === activityId);
        if (!entry) throw notFound('Activity not found');
        if (entry.before === undefined) throw bad('This entry cannot be undone');
        const id = entry.task;

        // Other stores (the schedule) register how to revert their own entries; they run inside this lock.
        if (undoHooks[entry.action]) {
          const result = await undoHooks[entry.action](entry, { actor });
          return result;
        }

        if (entry.action === 'schema') {
          const current = await schemaStore.get();
          // Content, not rev, decides: after undoing a later change the structure is back to what this entry wrote,
          // so it can be undone too (rev keeps increasing). Legacy entries without content fall back to rev.
          const unchanged = entry.after?.schema ? same(withoutRev(current), withoutRev(entry.after.schema)) : entry.after?.rev === undefined || current.rev === entry.after.rev;
          if (!unchanged) throw conflict('המבנה השתנה מאז הפעולה הזו — בטל קודם את השינויים המאוחרים יותר');
          const { before, after } = await schemaStore.saveUnlocked('replace', { ...entry.before.schema, rev: current.rev });
          const logged = await log({ actor, action: 'schema', task: null, title: 'מבנה הלוח', summary: `ביטול: ${entry.summary}`, before: { schema: before }, after: { rev: after.rev, schema: after } });
          onChange({ type: 'activity', activity: publicEntry(logged) });
          return { ok: true, schema: after };
        }

        if (entry.action === 'create' || entry.action === 'restore') {
          const raw = await readRaw(id);
          await mkdir(trash, { recursive: true });
          await rename(filename(id), join(trash, `${id}.md`));
          const space = parseTask(raw, id).space;
          const logged = await log({ actor, action: 'delete', task: id, title: entry.title, ...(space && { space }), summary: 'בוטלה היצירה', before: raw });
          onChange({ type: 'delete', id, space, activity: publicEntry(logged) });
          return { ok: true, id, deleted: true };
        }

        if (entry.action === 'delete') {
          const exists = await readFile(filename(id), 'utf8').then(() => true, () => false);
          if (exists) throw bad(`Task ${id} already exists`);
          await writeAtomic(filename(id), entry.before);
          const task = parseTask(entry.before, id);
          const logged = await log({ actor, action: 'restore', task: id, title: task.title, ...(task.space && { space: task.space }), summary: 'שוחזרה', before: null });
          onChange({ type: 'task', task, activity: publicEntry(logged) });
          return task;
        }

        // Field-level revert. Legacy entries stored the whole file; take the tracked fields from it.
        const previous = typeof entry.before === 'string' ? Object.fromEntries(TRACKED.map((k) => [k, parseTask(entry.before, id)[k]])) : entry.before;
        return updateLocked(id, (current) => {
          // Conflict check: only revert fields that still hold what this entry wrote; never silently
          // discard a later edit of the same field.
          if (entry.after) {
            const moved = Object.keys(previous).filter((k) => k in entry.after && !same(intent(k, current[k]), intent(k, entry.after[k])));
            if (moved.length) throw conflict(`השדות ${moved.join(', ')} השתנו שוב מאז — בטל קודם את השינוי המאוחר יותר`);
          }
          const changes = { ...previous };
          if (changes.fields) changes.fields = { ...Object.fromEntries(Object.keys(current.fields).map((k) => [k, null])), ...changes.fields };
          if (changes.reminders) {
            // Never re-arm a reminder that has already fired: keep current delivery state, retire past ones.
            changes.reminders = changes.reminders.map((r) => {
              const cur = current.reminders.find((c) => c.id === r.id);
              const merged = cur ? { ...r, sent_count: cur.sent_count, last_sent_at: cur.last_sent_at, done: cur.done || r.done } : { ...r };
              if (!merged.done && Date.parse(merged.at) <= Date.now() && (cur?.done || !cur)) merged.done = true;
              return merged;
            });
          }
          return changes;
        }, { actor, now, action: 'undo', summaryPrefix: 'ביטול: ' });
      });
    },
  };
  return store;
}
