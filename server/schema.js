// The board's structure lives in data/board.json so the agent (or the dashboard) can reshape the tool —
// statuses, priorities, projects, custom fields, saved views, notifications — without touching code.
// Logic never depends on status ids, only on each status's fixed `category`, so edits cannot break it.
import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLock, writeAtomic } from './fs-util.js';

export const CATEGORIES = ['inbox', 'todo', 'active', 'later', 'done'];
export const FIELD_TYPES = ['text', 'number', 'date', 'select', 'url', 'duration', 'checkbox'];
export const COLORS = ['gray', 'accent', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'pink', 'purple'];
export const LAYOUTS = ['list', 'board'];
export const GROUPS = ['none', 'status', 'project', 'priority', 'when'];
export const SORTS = ['manual', 'priority', 'deadline', 'when', 'updated', 'created', 'title'];

export const DEFAULT_SCHEMA = {
  version: 1,
  title: 'Workboard',
  // Links in WhatsApp messages (reminders, digest). From PUBLIC_URL; can be changed in Settings.
  publicUrl: process.env.PUBLIC_URL || process.env.WORKBOARD_PUBLIC_URL || '',
  statuses: [
    // Colour = status only: the resting default is neutral, active work gets the app blue, unsorted stands out.
    { id: 'inbox', label: 'לא ממוין', category: 'inbox', color: 'pink' },
    { id: 'next', label: 'הבא בתור', category: 'todo', color: 'gray' },
    { id: 'doing', label: 'בעבודה', category: 'active', color: 'accent' },
    { id: 'waiting', label: 'ממתין למישהו', category: 'active', color: 'amber' },
    { id: 'someday', label: 'מתישהו', category: 'later', color: 'purple' },
    { id: 'done', label: 'בוצע', category: 'done', color: 'green' },
  ],
  priorities: [
    { id: 'urgent', label: 'דחוף', color: 'red', rank: 0 },
    { id: 'high', label: 'גבוהה', color: 'orange', rank: 1 },
    { id: 'normal', label: 'רגילה', color: 'gray', rank: 2 },
    { id: 'low', label: 'נמוכה', color: 'teal', rank: 3 },
  ],
  defaultPriority: 'normal',
  // Where a task lands when nobody chose a status. Not the inbox: tasks should arrive already filed.
  defaultStatus: 'next',
  projects: [],
  tags: [],
  fields: [],
  views: [
    { id: 'waiting', name: 'ממתין לאחרים', icon: '⏸', filter: { status: ['waiting'] }, sort: 'updated', group: 'project', layout: 'list' },
  ],
  notifications: {
    enabled: true,
    channel: 'whatsapp',
    // Nags ("remind every N minutes until done") pause during quiet hours; explicit reminders always fire.
    quietHours: { start: '22:00', end: '07:30' },
    digest: { enabled: false, time: '08:30', days: [0, 1, 2, 3, 4] },
  },
};

const fail = (message) => Object.assign(new Error(message), { status: 400 });
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const idOk = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(id);
const timeOk = (t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

function uniqueIds(list, what) {
  const seen = new Set();
  for (const item of list) {
    if (!isObj(item)) throw fail(`${what}: every entry must be an object`);
    if (!idOk(item.id)) throw fail(`${what}: invalid id "${item.id}" (use lowercase a-z, 0-9, - or _)`);
    if (seen.has(item.id)) throw fail(`${what}: duplicate id "${item.id}"`);
    seen.add(item.id);
  }
}

function filterOk(filter, where) {
  if (filter === undefined) return;
  if (!isObj(filter)) throw fail(`${where}: filter must be an object`);
  const allowed = ['status', 'category', 'project', 'priority', 'tags', 'due', 'text', 'source', 'hasReminder'];
  for (const key of Object.keys(filter)) if (!allowed.includes(key)) throw fail(`${where}: unknown filter key "${key}" (allowed: ${allowed.join(', ')})`);
}

/** Validates a full schema and returns a normalized copy. Throws a readable error on the first problem. */
export function validateSchema(input) {
  if (!isObj(input)) throw fail('Schema must be a JSON object');
  const s = structuredClone({ ...DEFAULT_SCHEMA, ...input });
  s.notifications = { ...DEFAULT_SCHEMA.notifications, ...(input.notifications || {}) };
  s.notifications.quietHours = { ...DEFAULT_SCHEMA.notifications.quietHours, ...(input.notifications?.quietHours || {}) };
  s.notifications.digest = { ...DEFAULT_SCHEMA.notifications.digest, ...(input.notifications?.digest || {}) };

  for (const key of ['statuses', 'priorities', 'projects', 'fields', 'views', 'tags']) {
    if (!Array.isArray(s[key])) throw fail(`${key} must be an array`);
  }
  uniqueIds(s.statuses, 'statuses');
  if (!s.statuses.length) throw fail('statuses: at least one status is required');
  for (const st of s.statuses) {
    if (!st.label) throw fail(`statuses: "${st.id}" needs a label`);
    if (!CATEGORIES.includes(st.category)) throw fail(`statuses: "${st.id}" category must be one of ${CATEGORIES.join(', ')}`);
    st.color = COLORS.includes(st.color) ? st.color : 'gray';
  }
  if (!s.statuses.some((st) => st.id === s.defaultStatus)) s.defaultStatus = (s.statuses.find((st) => st.category === 'todo') || s.statuses.find((st) => st.category === 'inbox')).id;
  for (const needed of ['inbox', 'done']) {
    if (!s.statuses.some((st) => st.category === needed)) throw fail(`statuses: at least one status must have category "${needed}"`);
  }
  uniqueIds(s.priorities, 'priorities');
  if (!s.priorities.length) throw fail('priorities: at least one priority is required');
  s.priorities.forEach((p, i) => { if (!p.label) throw fail(`priorities: "${p.id}" needs a label`); p.rank = Number.isFinite(p.rank) ? p.rank : i; p.color = COLORS.includes(p.color) ? p.color : 'gray'; });
  if (!s.priorities.some((p) => p.id === s.defaultPriority)) s.defaultPriority = s.priorities[Math.floor(s.priorities.length / 2)].id;

  uniqueIds(s.projects, 'projects');
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  for (const p of s.projects) {
    if (!p.name) throw fail(`projects: "${p.id}" needs a name`);
    p.color = COLORS.includes(p.color) ? p.color : 'teal';
    p.archived = Boolean(p.archived);
    // Goals: what "done" means for the project, when it's due, and dated milestones on the way.
    p.goal = typeof p.goal === 'string' ? p.goal.trim().slice(0, 300) : '';
    if (p.due !== undefined && p.due !== null && p.due !== '' && !(typeof p.due === 'string' && DATE.test(p.due))) throw fail(`projects: "${p.id}".due must be YYYY-MM-DD or null`);
    p.due = p.due || null;
    if (p.aliases !== undefined && !Array.isArray(p.aliases)) throw fail(`projects: "${p.id}".aliases must be an array of strings`);
    p.aliases = (p.aliases || []).map((a) => String(a).trim()).filter(Boolean);
    if (p.milestones !== undefined && !Array.isArray(p.milestones)) throw fail(`projects: "${p.id}".milestones must be an array`);
    const seen = new Set();
    p.milestones = (p.milestones || []).map((m, i) => {
      if (!m || typeof m !== 'object' || !String(m.title || '').trim()) throw fail(`projects: "${p.id}".milestones[${i}] needs a title`);
      if (m.date && !DATE.test(m.date)) throw fail(`projects: "${p.id}".milestones[${i}].date must be YYYY-MM-DD`);
      let id = typeof m.id === 'string' && /^m[a-z0-9]{1,12}$/.test(m.id) ? m.id : `m${Math.random().toString(36).slice(2, 8)}`;
      while (seen.has(id)) id = `m${Math.random().toString(36).slice(2, 8)}`;
      seen.add(id);
      return { id, title: String(m.title).trim().slice(0, 200), date: m.date || null, done: Boolean(m.done) };
    }).sort((a, b) => (a.date || '9').localeCompare(b.date || '9'));
  }
  s.tags = [...new Set(s.tags.map((t) => String(t).trim()).filter(Boolean))];

  uniqueIds(s.fields, 'fields');
  for (const f of s.fields) {
    if (!f.label) throw fail(`fields: "${f.id}" needs a label`);
    if (!FIELD_TYPES.includes(f.type)) throw fail(`fields: "${f.id}" type must be one of ${FIELD_TYPES.join(', ')}`);
    if (f.type === 'select' && (!Array.isArray(f.options) || !f.options.length)) throw fail(`fields: select field "${f.id}" needs options`);
    if (f.projects !== undefined && !Array.isArray(f.projects)) throw fail(`fields: "${f.id}".projects must be an array of project ids`);
    f.showOnCard = Boolean(f.showOnCard);
  }

  uniqueIds(s.views, 'views');
  for (const v of s.views) {
    if (!v.name) throw fail(`views: "${v.id}" needs a name`);
    filterOk(v.filter, `views: "${v.id}"`);
    v.filter = v.filter || {};
    v.layout = LAYOUTS.includes(v.layout) ? v.layout : 'list';
    v.group = GROUPS.includes(v.group) ? v.group : 'none';
    v.sort = SORTS.includes(v.sort) ? v.sort : 'priority';
  }

  const n = s.notifications;
  n.enabled = Boolean(n.enabled);
  if (!timeOk(n.quietHours.start) || !timeOk(n.quietHours.end)) throw fail('notifications.quietHours: use HH:MM');
  if (!timeOk(n.digest.time)) throw fail('notifications.digest.time: use HH:MM');
  if (!Array.isArray(n.digest.days) || n.digest.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw fail('notifications.digest.days: array of 0 (Sunday) … 6 (Saturday)');
  n.digest.enabled = Boolean(n.digest.enabled);
  s.rev = Number.isInteger(input.rev) ? input.rev : 0;
  return s;
}

export function createSchemaStore(dataDir, { lock = createLock() } = {}) {
  const path = join(dataDir, 'board.json');
  const lastGood = join(dataDir, 'board.last-good.json');
  let cache = null;
  let degraded = null; // reason string while board.json is unreadable
  let usage = async () => ({ statuses: new Map(), projects: new Map() });

  async function readValid(file) {
    return validateSchema(JSON.parse(await readFile(file, 'utf8')));
  }

  async function load() {
    if (cache) return cache;
    try {
      cache = await readValid(path);
      degraded = null;
      return cache;
    } catch (error) {
      if (error.code === 'ENOENT') {
        cache = validateSchema(DEFAULT_SCHEMA);
        await writeAtomic(path, `${JSON.stringify(cache, null, 2)}\n`);
        return cache;
      }
      // A hand-edit broke the file. Keep a copy, serve the last good structure (or defaults), and refuse
      // structure writes until someone explicitly restores — so nothing silently overwrites the original.
      const backup = `${path}.broken-${Date.now()}`;
      await copyFile(path, backup).catch(() => {});
      degraded = `board.json is invalid (${error.message}); copy saved as ${backup.split('/').pop()}`;
      console.error(`[schema] ${degraded}`);
      try { cache = await readValid(lastGood); } catch { cache = validateSchema(DEFAULT_SCHEMA); }
      return cache;
    }
  }

  /** Statuses/projects still used by tasks can't be removed — that would strand those tasks. */
  async function checkRemovals(current, next) {
    const used = await usage();
    for (const [key, label, hint] of [['statuses', 'status', 'move those tasks to another status first'], ['projects', 'project', 'set "archived": true instead, or move the tasks first']]) {
      const kept = new Set(next[key].map((x) => x.id));
      for (const old of current[key]) {
        const n = used[key].get(old.id) || 0;
        if (!kept.has(old.id) && n) throw fail(`Can't remove ${label} "${old.id}" — ${n} task(s) still use it; ${hint}`);
      }
    }
  }

  async function write(valid) {
    await writeAtomic(path, `${JSON.stringify(valid, null, 2)}\n`);
    await writeAtomic(lastGood, `${JSON.stringify(valid, null, 2)}\n`);
    cache = valid;
  }

  /** Must be called while holding the shared lock. `rev` is metadata: every successful write increments it. */
  async function saveUnlocked(kind, input) {
    if (!isObj(input)) throw fail(kind === 'patch' ? 'Schema patch must be an object' : 'Schema must be a JSON object');
    const current = await load();
    if (degraded) throw Object.assign(new Error(`${degraded}. Fix the file by hand, or POST /api/schema/restore to accept the structure currently shown.`), { status: 503, code: 'schema_degraded' });
    const next = kind === 'patch' ? { ...current, ...input } : input;
    // Optimistic concurrency: a writer that read an older revision must re-read and retry.
    if (next.rev !== undefined && next.rev !== current.rev) {
      throw Object.assign(new Error(`The board structure changed meanwhile (rev ${current.rev}, you sent ${next.rev}). GET /api/schema and apply your change again.`), { status: 409, code: 'conflict' });
    }
    const valid = validateSchema({ ...next, rev: current.rev });
    await checkRemovals(current, valid);
    valid.rev = current.rev + 1;
    await write(valid);
    return { before: current, after: valid };
  }

  return {
    get: load,
    degraded: () => degraded,
    setUsage(fn) { usage = fn; },
    saveUnlocked,
    replace(next) { return lock(async () => (await saveUnlocked('replace', next)).after); },
    /** Shallow-merges top-level keys (e.g. just `{ projects: [...] }`). */
    patch(changes) { return lock(async () => (await saveUnlocked('patch', changes)).after); },
    restore() {
      return lock(async () => {
        const current = await load();
        const valid = { ...current, rev: current.rev + 1 };
        await write(valid);
        degraded = null;
        return valid;
      });
    },
    invalidate() { cache = null; },
  };
}
