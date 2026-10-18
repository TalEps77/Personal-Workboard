import { addDays, dow, localDate, niceDate, today, isWorkHours } from './util.js';

const listeners = new Set();
export const state = {
  schema: null,
  tasks: new Map(),
  activity: [],
  events: [], // the schedule (לו״ז)
  // Several people: who I am, the spaces I can see (my work, my personal, our home), and the shared shopping list.
  me: null,
  actor: 'dashboard',
  people: [],
  spaces: [],
  multi: false,
  shopping: null,
  depts: [],
  notifier: { configured: false },
  online: false,
  route: { view: 'today', param: null },
  openTask: null,
  search: '',
  ui: JSON.parse(localStorage.getItem('wb-ui') || '{}'),
};

export function setState(patch) {
  Object.assign(state, patch);
  emit();
}
export function setUi(patch) {
  state.ui = { ...state.ui, ...patch };
  localStorage.setItem('wb-ui', JSON.stringify(state.ui));
  emit();
}
// What the server last confirmed for each task, plus this device's writes still in flight. The screen shows
// confirmed + pending; a response or live event older than the confirmed version is dropped, so a slow reply can
// never roll the board back over a newer change (found in an integration review).
export const confirmed = new Map();
const pending = new Map(); // id → [{ seq, changes }]
const deleted = new Set(); // tombstones: a late reply about a deleted task must not bring it back
let seq = 0;
const overlay = (task, changes) => ({ ...task, ...changes, fields: changes.fields ? { ...task.fields, ...changes.fields } : task.fields, version: task.version });
function show(id) {
  const base = confirmed.get(id);
  if (!base) return;
  state.tasks.set(id, (pending.get(id) || []).reduce((t, p) => overlay(t, p.changes), base));
}
export function putTask(task, { force = false, revive = false } = {}) {
  if (deleted.has(task.id) && !revive) return;
  deleted.delete(task.id);
  const current = confirmed.get(task.id);
  if (!force && current && (current.version ?? 0) > (task.version ?? 0)) return;
  confirmed.set(task.id, task);
  show(task.id);
  emit();
  onConfirmed();
}
export function dropTask(id) { deleted.add(id); confirmed.delete(id); pending.delete(id); state.tasks.delete(id); emit(); onConfirmed(); }
/** A full reload (bootstrap): still never older than what live events already confirmed. */
export function replaceTasks(tasks) {
  const incoming = new Map(tasks.map((t) => [t.id, t]));
  for (const id of [...confirmed.keys()]) if (!incoming.has(id)) confirmed.delete(id);
  for (const t of tasks) {
    const current = confirmed.get(t.id);
    if (!current || (current.version ?? 0) <= (t.version ?? 0)) confirmed.set(t.id, t);
    deleted.delete(t.id);
  }
  state.tasks = new Map();
  for (const id of confirmed.keys()) show(id);
}
/** Shows an edit at once; returns a handle to settle it when the server answers. */
export function beginWrite(id, changes) {
  const s = ++seq;
  pending.set(id, [...(pending.get(id) || []), { seq: s, changes }]);
  show(id); emit();
  return s;
}
/** `ok`: the write succeeded — it also supersedes older in-flight edits of the same fields (latest intent wins). */
export function endWrite(id, s, { ok = false } = {}) {
  const mine = (pending.get(id) || []).find((p) => p.seq === s);
  let left = (pending.get(id) || []).filter((p) => p.seq !== s);
  if (ok && mine) {
    const keys = Object.keys(mine.changes);
    left = left.map((p) => (p.seq < s ? { ...p, changes: Object.fromEntries(Object.entries(p.changes).filter(([k]) => !keys.includes(k))) } : p)).filter((p) => Object.keys(p.changes).length);
  }
  if (left.length) pending.set(id, left); else pending.delete(id);
  show(id); emit();
}
let onConfirmed = () => {};
export const setConfirmedListener = (fn) => { onConfirmed = fn; };
export const subscribe = (fn) => listeners.add(fn);
let queued = false;
function emit() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; for (const fn of listeners) fn(state); });
}

// ---- Schema lookups ----
export const statusOf = (id) => state.schema.statuses.find((s) => s.id === id) || { id, label: `${id} (לא קיים)`, category: 'todo', color: 'gray' };
export const categoryOf = (task) => statusOf(task.status).category;
export const priorityOf = (id) => state.schema.priorities.find((p) => p.id === id) || { id, label: id, rank: 9, color: 'gray' };
export const projectOf = (id) => state.schema.projects.find((p) => p.id === id) || null;
// Board order for display: "unsorted" (inbox category) always goes last — it should be empty most of the time.
export const orderedStatuses = () => [...state.schema.statuses.filter((s) => s.category !== 'inbox'), ...state.schema.statuses.filter((s) => s.category === 'inbox')];
export const firstStatus = (category) => state.schema.statuses.find((s) => s.category === category)?.id;
export const isDone = (task) => categoryOf(task) === 'done';
export const progress = (task) => ({ done: task.steps.filter((s) => s.done).length, total: task.steps.length });
export const fieldsFor = (task) => state.schema.fields.filter((f) => !f.projects?.length || f.projects.includes(task.project));
export const nextReminder = (task) => task.reminders.filter((r) => !r.done).sort((a, b) => a.at.localeCompare(b.at))[0] || null;

// ---- Spaces ----
const DEFAULT_SPACE = 'work';
export const spaceOf = (task) => task?.space || state.spaces.find((x) => x.id === DEFAULT_SPACE)?.id || state.spaces[0]?.id || DEFAULT_SPACE;
export const spaceInfo = (id) => state.spaces.find((x) => x.id === id) || null;
export const kindOfSpace = (task) => spaceInfo(spaceOf(task))?.kind || 'work';

const myWorkSpace = () => state.spaces.find((x) => x.kind === 'work' && x.owner === state.me?.id)?.id || null;
/** The context picked on this device: "auto" (default), "all", or a space id. */
export const contextChoice = () => (!state.multi ? 'all' : state.ui.space === undefined ? 'auto' : state.ui.space === 'auto' || state.ui.space === 'all' || state.spaces.some((x) => x.id === state.ui.space) ? state.ui.space : 'auto');
/** The space the app is in right now ("all" or a space id) — what every screen filters and adapts to. */
export { isWorkHours };
/** The space the app is in right now ("all" or a space id) — "auto" = my work space during work hours, else all. */
export const currentSpace = () => {
  const c = contextChoice();
  if (c === 'auto') return isWorkHours() && myWorkSpace() ? myWorkSpace() : 'all';
  return c;
};
/** work / personal / home / all — drives colour, tabs and what Today shows. */
export const currentKind = () => (currentSpace() === 'all' ? 'all' : spaceInfo(currentSpace())?.kind || 'all');
export const inCurrentSpace = (task) => currentSpace() === 'all' || spaceOf(task) === currentSpace();
/** Mine to do: my own spaces, and shared tasks on me, on both of us, or on nobody yet (same rule as the server). */
export const isMine = (task) => {
  const s = spaceInfo(spaceOf(task));
  if (!s) return true;
  if (!s.shared) return true;
  return !task.assignee || task.assignee === 'both' || task.assignee === state.me?.id;
};
// ---- Speaking to the person in their own grammatical gender ----
// UI copy is written in the masculine/neutral form; for a woman, gx`…` turns its imperatives and "את/ה" forms
// feminine. A tagged template, so only the literal text changes — never a task title or a list item inside ${}.
const FEM = { 'סגור': 'סגרי', 'נסה': 'נסי', 'החלק': 'החליקי', 'אשר': 'אשרי', 'חפש': 'חפשי', 'עבור': 'עברי', 'צור': 'צרי', 'פתח': 'פתחי', 'שלח': 'שלחי', 'סמן': 'סמני', 'החזר': 'החזירי', 'העבר': 'העבירי', 'בחר': 'בחרי', 'דחה': 'דחי', 'הוסף': 'הוסיפי', 'גרור': 'גררי', 'מחק': 'מחקי', 'פרק': 'פרקי', 'הקלד': 'הקלידי', 'לחץ': 'לחצי', 'קבע': 'קבעי', 'בטל': 'בטלי', 'התחל': 'התחילי', 'ספר': 'ספרי', 'שמור': 'שמרי', 'הצג': 'הציגי', 'ערוך': 'ערכי', 'תן': 'תני', 'בקש': 'בקשי', 'ענה': 'עני', 'סווג': 'סווגי', 'עדכן': 'עדכני', 'בדוק': 'בדקי', 'הזן': 'הזיני' };
const FEM_RE = new RegExp(`(^|[^\u0590-\u05FF])(ו?)(${Object.keys(FEM).join('|')})(?![\u0590-\u05FF])`, 'g');
export const isFemale = () => state.me?.gender === 'f';
export function genderize(text) {
  if (!state.me) return String(text); // before sign-in (pairing) the copy stays neutral: את/ה
  const f = isFemale();
  let out = String(text).replace(/את\/ה/g, f ? 'את' : 'אתה').replace(/([\u0590-\u05FF]+)\/(י|ת)(?![\u0590-\u05FF])/g, (m, w, suf) => (f ? `${w.replace(/[ךםןףץ]$/, (c) => ({ 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' })[c])}${suf}` : w));
  if (f) out = out.replace(FEM_RE, (m, pre, vav, w) => `${pre}${vav}${FEM[w]}`);
  return out;
}
export const gx = (strings, ...values) => strings.reduce((acc, s, i) => acc + genderize(s) + (i < values.length ? values[i] : ''), '');
/** One phrase that differs by gender beyond the word list: g('תצטרך', 'תצטרכי'). */
export const g = (male, female) => (isFemale() ? female : male);

/** My agent's name (people.json `agent`), for copy like "ספר ל־…". */
export const agentName = () => state.me?.agent || 'הסוכן';
export const personName = (id) => (id === 'both' ? 'שנינו' : state.people.find((p) => p.id === id)?.name || id);
/** Space a new task gets: the one being looked at, else my work space. */
export const newTaskSpace = () => (currentSpace() !== 'all' ? currentSpace() : state.spaces.find((x) => x.kind === 'work' && !x.shared && x.owner === state.me?.id)?.id || null);
/** Who did something, from the activity log's actor id. */
export function actorInfo(actor) {
  if (actor === state.actor) return { name: gx`את/ה`, icon: 'monitor', self: true };
  const viaDash = /^dashboard(-(.+))?$/.exec(actor || '');
  if (viaDash) { const p = state.people.find((x) => x.id === (viaDash[2] || state.defaultUser || state.people[0]?.id)); return { name: p?.name || 'מהלוח', icon: 'monitor', person: true }; }
  const agentOf = state.people.find((x) => x.agentActor === actor);
  if (agentOf) return { name: agentOf.agent || actor, icon: 'bot', agent: true, mine: agentOf.id === state.me?.id };
  // The default agent token without a configured agentActor shows up as "agent": call it by my agent's name.
  if (actor === 'agent') return { name: agentName(), icon: 'bot', agent: true, mine: true };
  return { name: String(actor || '').replace(/[-_]/g, ' '), icon: 'bot', agent: true };
}

/** Projects of the space being looked at (all of mine on "הכל"). */
export const projectsHere = () => state.schema.projects.filter((p) => currentSpace() === 'all' || (p.space || DEFAULT_SPACE) === currentSpace());

export function allTasks({ archived = false, anySpace = false } = {}) {
  return [...state.tasks.values()].filter((t) => (archived || !t.archived) && (anySpace || inCurrentSpace(t)));
}

// ---- Filtering / sorting / grouping (same vocabulary as views in board.json) ----
export function matches(task, filter = {}, search = '') {
  const t = today();
  const cat = categoryOf(task);
  const arr = (v) => (v === undefined ? [] : [].concat(v));
  if (arr(filter.status).length && !arr(filter.status).includes(task.status)) return false;
  if (arr(filter.category).length && !arr(filter.category).includes(cat)) return false;
  if (arr(filter.project).length && !arr(filter.project).includes(task.project || 'none')) return false;
  if (arr(filter.priority).length && !arr(filter.priority).includes(task.priority)) return false;
  if (arr(filter.tags).length && !arr(filter.tags).some((tag) => task.tags.includes(tag))) return false;
  if (filter.source && task.source !== filter.source) return false;
  if (filter.hasReminder && !task.reminders.some((r) => !r.done)) return false;
  if (filter.due === 'overdue' && !(task.deadline && task.deadline < t && cat !== 'done')) return false;
  if (filter.due === 'today' && !(task.deadline === t || (task.when && task.when <= t))) return false;
  if (filter.due === 'week' && !((task.deadline && task.deadline <= addDays(t, 7)) || (task.when && task.when <= addDays(t, 7)))) return false;
  const q = (filter.text || search || '').trim().toLowerCase();
  if (q) {
    const hay = `#${task.id} ${task.title} ${task.notes} ${task.steps.map((s) => s.text).join(' ')} ${task.tags.map((x) => `#${x}`).join(' ')} ${projectOf(task.project)?.name || ''} ${Object.values(task.fields || {}).join(' ')}`.toLowerCase();
    if (!q.split(/\s+/).every((word) => hay.includes(word))) return false;
  }
  return true;
}

const rank = (task) => priorityOf(task.priority).rank;
// ---- Date horizons: the order a list is read in ("what's due first") ----
// A task's date = the earliest of its deadline and planned work day. A passed deadline is overdue; a passed work day
// with no passed deadline is carried into today. Weeks run Sunday–Saturday (work days are configurable on the server).
export const HORIZONS = [
  { key: 'overdue', label: 'באיחור', tone: 'danger' },
  { key: 'today', label: 'היום' },
  { key: 'tomorrow', label: 'מחר' },
  { key: 'week', label: 'בהמשך השבוע' },
  { key: 'nextweek', label: 'שבוע הבא' },
  { key: 'later', label: 'בהמשך' },
  { key: 'none', label: 'ללא תאריך' },
  { key: 'someday', label: 'מתישהו' },
];
/** The date a task asks for attention: the earlier of its work day and its deadline. */
export const taskDate = (task) => [task.when, task.deadline].filter(Boolean).sort()[0] || null;
/** Only a passed DEADLINE is overdue; a passed work day is "carried" into today (shown with a chip). */
export const isCarried = (task, t = today()) => Boolean(task.when && task.when < t && !(task.deadline && task.deadline < t));
export function horizonOf(task, t = today()) {
  if (categoryOf(task) === 'later') return 'someday';
  if (task.deadline && task.deadline < t) return 'overdue';
  const d = taskDate(task);
  if (!d) return 'none';
  if (d <= t) return 'today';
  if (d === addDays(t, 1)) return 'tomorrow';
  const weekEnd = addDays(t, 6 - dow(t)); // Saturday of this week
  if (d <= weekEnd) return 'week';
  if (d <= addDays(weekEnd, 7)) return 'nextweek';
  return 'later';
}
/** Tasks → [{ key, label, tone, tasks }] in reading order, each sorted by date. Empty horizons are dropped. */
export function byHorizon(tasks) {
  const sorted = sortTasks(tasks, 'date');
  return HORIZONS.map((hz) => ({ ...hz, tasks: sorted.filter((x) => horizonOf(x) === hz.key) })).filter((g) => g.tasks.length);
}
/** Board / status groups in the order work flows: in progress, next, waiting, later, unsorted, done. */
const FLOW = { active: 0, todo: 1, later: 3, inbox: 4, done: 5 };
export const flowRank = (status) => (status.category === 'active' && (status.id === 'waiting' || /ממתין|waiting/i.test(status.label)) ? 2 : FLOW[status.category] ?? 1);
export const flowStatuses = () => [...orderedStatuses()].sort((a, b) => flowRank(a) - flowRank(b));
const horizonRank = (task) => HORIZONS.findIndex((x) => x.key === horizonOf(task));

/** "New from the agent": unseen, added by an agent, in the last 3 days — a signal, not a mark on everything. */
export const isFresh = (task) => !task.seen && !isDone(task) && task.source !== 'dashboard' && Date.now() - Date.parse(task.created_at || 0) < 3 * 86400_000;

export const SORTERS = {
  // Default everywhere: by date horizon, then the date itself, a hard deadline before a soft plan, then priority.
  date: (a, b) => horizonRank(a) - horizonRank(b) || (taskDate(a) || '9').localeCompare(taskDate(b) || '9') || (b.deadline ? 1 : 0) - (a.deadline ? 1 : 0) || rank(a) - rank(b) || Number(a.id) - Number(b.id),
  manual: (a, b) => (a.order || 0) - (b.order || 0),
  priority: (a, b) => rank(a) - rank(b) || (a.deadline || '9').localeCompare(b.deadline || '9') || (a.order || 0) - (b.order || 0),
  deadline: (a, b) => (a.deadline || '9').localeCompare(b.deadline || '9') || rank(a) - rank(b),
  when: (a, b) => (a.when || '9').localeCompare(b.when || '9') || rank(a) - rank(b),
  updated: (a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''),
  created: (a, b) => (b.created_at || '').localeCompare(a.created_at || ''),
  title: (a, b) => a.title.localeCompare(b.title, 'he'),
};
export const sortTasks = (tasks, sort = 'date') => [...tasks].sort(SORTERS[sort] || SORTERS.date);

export function groupTasks(tasks, group) {
  if (!group || group === 'none') return [{ key: 'all', label: null, tasks }];
  const groups = new Map();
  const add = (key, label, extra, task) => { if (!groups.has(key)) groups.set(key, { key, label, ...extra, tasks: [] }); groups.get(key).tasks.push(task); };
  for (const task of tasks) {
    if (group === 'status') { const s = statusOf(task.status); add(s.id, s.label, { color: s.color }, task); }
    if (group === 'priority') { const p = priorityOf(task.priority); add(p.id, p.label, { color: p.color, rank: p.rank }, task); }
    if (group === 'project') { const p = projectOf(task.project); add(p?.id || 'none', p?.name || 'ללא פרויקט', { color: p?.color || 'gray' }, task); }
    if (group === 'when') { const hz = HORIZONS.find((x) => x.key === horizonOf(task)); add(hz.key, hz.label, { tone: hz.tone }, task); }
    if (group === 'with') {
      const people = String(task.fields?.with || '').split(/[,،]/).map((x) => x.trim()).filter(Boolean);
      if (!people.length) add('~none', 'בלי אנשים', {}, task);
      for (const person of people) add(person, person, {}, task);
    }
  }
  const order = group === 'status' ? flowStatuses().map((s) => s.id) : group === 'priority' ? state.schema.priorities.map((p) => p.id) : group === 'project' ? [...state.schema.projects.map((p) => p.id), 'none'] : group === 'when' ? HORIZONS.map((x) => x.key) : group === 'with' ? [...groups.keys()].sort((a, b) => (a === '~none') - (b === '~none') || groups.get(b).tasks.length - groups.get(a).tasks.length || a.localeCompare(b, 'he')) : [...groups.keys()].sort();
  // Groups whose key the schema no longer knows (e.g. a status removed by hand) still show, at the end.
  return [...order.filter((k) => groups.has(k)), ...[...groups.keys()].filter((k) => !order.includes(k))].map((k) => groups.get(k));
}

/** "Waiting for someone": a follow-up, never part of the person's own work for today (same rule as server/summary.js agenda). */
export const isWaiting = (task) => { const s = statusOf(task.status); return Boolean(s) && s.category !== 'done' && (s.id === 'waiting' || /ממתין|waiting/i.test(s.label)); };

export function todayBuckets() {
  const t = today();
  const open = allTasks().filter((x) => !isDone(x) && isMine(x));
  const mine = open.filter((x) => !isWaiting(x) && categoryOf(x) !== 'inbox');
  const overdue = mine.filter((x) => x.deadline && x.deadline < t);
  const followups = open.filter((x) => isWaiting(x) && ((x.when && x.when <= t) || (x.deadline && x.deadline <= t)));
  const planned = mine.filter((x) => !overdue.includes(x) && (x.when === t || x.deadline === t));
  // Planned for an earlier day and still open (e.g. weekly work put on Sunday) — shown apart from today's plan.
  const carried = mine.filter((x) => !overdue.includes(x) && !planned.includes(x) && x.when && x.when < t);
  const dated = new Set([...overdue, ...planned, ...carried, ...followups]);
  const active = open.filter((x) => categoryOf(x) === 'active' && !dated.has(x));
  // Live view: each "active" status (בעבודה, ממתין למישהו…) is its own section, in schema order.
  const activeGroups = state.schema.statuses.filter((s) => s.category === 'active').map((s) => ({ status: s, tasks: sortTasks(active.filter((x) => x.status === s.id)) })).filter((g) => g.tasks.length);
  const nextUp = sortTasks(open.filter((x) => categoryOf(x) === 'todo' && !dated.has(x)));
  const unsorted = sortTasks(open.filter((x) => categoryOf(x) === 'inbox'), 'created');
  const fresh = open.filter(isFresh);
  const reminders = open.flatMap((x) => x.reminders.filter((r) => !r.done && localDate(r.at) <= t).map((r) => ({ task: x, reminder: r }))).sort((a, b) => a.reminder.at.localeCompare(b.reminder.at));
  const doneToday = allTasks({ archived: true }).filter((x) => isMine(x) && x.completed_at && localDate(x.completed_at) === t);
  const doing = active.filter((x) => !isWaiting(x));
  return { overdue: sortTasks(overdue, 'deadline'), planned: sortTasks(planned), carried: sortTasks(carried, 'when'), followups: sortTasks(followups), active: sortTasks(doing), activeGroups, nextUp, unsorted, fresh, reminders, doneToday, open };
}

export function counts() {
  const open = allTasks().filter((x) => !isDone(x));
  const b = todayBuckets();
  return {
    today: b.overdue.length + b.planned.length + b.carried.length + b.active.length,
    inbox: open.filter((x) => categoryOf(x) === 'inbox').length,
    fresh: b.fresh.length,
    open: open.length,
    upcoming: open.filter((x) => (x.when && x.when > today()) || (x.deadline && x.deadline > today())).length,
  };
}
