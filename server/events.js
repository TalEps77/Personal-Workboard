// Each person's schedule ("לו״ז"): meetings and blocked work time they tell their agent about (for when work calendars
// can't be connected). Each item can point at a task, and Workboard itself reminds them on WhatsApp before it starts.
// Stored as one JSON file next to the tasks; every change is in the activity log and can be undone.
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeAtomic } from './fs-util.js';
import { isRealDate, isRealTime } from './dates.js';
import { local, zoned } from './time.js';

export const EVENT_KINDS = { meeting: 'דיון / פגישה', work: 'זמן עבודה', other: 'אחר' };
/** Default lead time (minutes before start) when none was asked for — a heads-up before everything by default. */
export const DEFAULT_LEAD = { meeting: 15, work: 10, other: 10 };
const bad = (message) => Object.assign(new Error(message), { status: 400, code: 'invalid' });
const notFound = (message) => Object.assign(new Error(message), { status: 404, code: 'not_found' });
const conflict = (message) => Object.assign(new Error(message), { status: 409, code: 'conflict' });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const HHMM = /^(\d{1,2}):(\d{2})$/;
const pad = (n) => String(n).padStart(2, '0');

export function normTime(value, name) {
  const m = String(value ?? '').trim().match(HHMM);
  if (!m || !isRealTime(+m[1], +m[2])) throw bad(`${name} must be HH:MM (got "${value}")`);
  return `${pad(+m[1])}:${m[2]}`;
}
/** UTC ms of an event's start / end (instance wall-clock). */
export const startMs = (e) => zoned(...e.date.split('-').map(Number), ...e.start.split(':').map(Number));
export const endMs = (e) => (e.end ? zoned(...e.date.split('-').map(Number), ...e.end.split(':').map(Number)) : startMs(e) + 30 * 60_000);
export const leadOf = (e) => (Number.isFinite(e.remind) ? e.remind : DEFAULT_LEAD[e.kind] ?? 10);
/** When the WhatsApp heads-up is due (null = no reminder: remind === -1). */
export const remindMs = (e) => (e.remind === -1 ? null : startMs(e) - leadOf(e) * 60_000);

/** Validates and normalises an event (creating or merging into `base`). Delivery bookkeeping is kept from `base`. */
export function normalizeEvent(input, base = null) {
  const e = { ...(base || { id: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, kind: 'meeting', remind: null, task: null, with: '', location: '', notes: '', reminded_at: null, owner: null, space: null }) };
  for (const k of ['title', 'date', 'start', 'end', 'kind', 'remind', 'task', 'with', 'location', 'notes', 'owner', 'space']) if (input[k] !== undefined) e[k] = input[k];
  // Which part of life it belongs to (work / personal / home space id) — decides its colour everywhere. null = work.
  e.space = e.space === undefined || e.space === '' ? null : e.space;
  if (e.space !== null && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(e.space)) throw bad('space must be a space id');
  // Whose schedule: a person id, 'home' (both of us), or null (items from before there were several people).
  e.owner = e.owner === undefined || e.owner === '' ? null : e.owner;
  if (e.owner !== null && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(e.owner)) throw bad('owner must be a person id or "home"');
  e.title = String(e.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!e.title) throw bad('title is required');
  const dm = String(e.date ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dm || !isRealDate(+dm[1], +dm[2], +dm[3])) throw bad(`date must be a real YYYY-MM-DD (got "${e.date}")`);
  e.start = normTime(e.start, 'start');
  e.end = e.end ? normTime(e.end, 'end') : null;
  if (e.end && e.end <= e.start) throw bad(`end (${e.end}) must be after start (${e.start})`);
  if (!EVENT_KINDS[e.kind]) throw bad(`kind must be one of ${Object.keys(EVENT_KINDS).join(', ')}`);
  if (e.remind !== null && e.remind !== undefined && !(Number.isInteger(e.remind) && (e.remind === -1 || (e.remind >= 0 && e.remind <= 24 * 60)))) throw bad('remind = minutes before start (0–1440), -1 for no reminder, or null for the default');
  e.remind = e.remind ?? null;
  e.task = e.task === null || e.task === undefined || e.task === '' ? null : String(e.task);
  if (e.task !== null && !/^[1-9]\d{0,6}$/.test(e.task)) throw bad('task must be a task id');
  for (const k of ['with', 'location', 'notes']) e[k] = String(e[k] ?? '').slice(0, k === 'notes' ? 2000 : 200);
  // A new time is a new occurrence: it gets its own reminder.
  if (base && (base.date !== e.date || base.start !== e.start || base.remind !== e.remind)) { e.reminded_at = null; e.remind_error = null; e.retry_at = null; e.attempts = 0; }
  return e;
}

const DOW = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const dayLabel = (d) => `${DOW[new Date(`${d}T12:00:00Z`).getUTCDay()]} ${Number(d.slice(8))}.${Number(d.slice(5, 7))}`;
export const eventWhen = (e) => `${dayLabel(e.date)} ${e.start}${e.end ? `–${e.end}` : ''}`;

export function createEventStore(root, { lock, taskStore, onChange = () => {} }) {
  const path = join(root, 'data', 'events.json');
  const read = async () => { try { const d = JSON.parse(await readFile(path, 'utf8')); return Array.isArray(d.items) ? d.items : []; } catch { return []; } };
  const save = (items) => writeAtomic(path, JSON.stringify({ items: items.sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`)) }, null, 2));
  const announce = () => onChange({ type: 'events' });
  const summary = (e) => `${e.title} · ${eventWhen(e)}`;

  async function checkTask(id) {
    if (id === null) return;
    try { await taskStore.get(id); } catch { throw bad(`task #${id} does not exist`); }
  }

  const store = {
    async list({ from = null, to = null } = {}) {
      return (await read()).filter((e) => (!from || e.date >= from) && (!to || e.date <= to));
    },
    async get(id) { const e = (await read()).find((x) => x.id === id); if (!e) throw notFound(`Event ${id} not found`); return e; },

    create(input, { actor = 'dashboard' } = {}) {
      return lock(async () => {
        const e = normalizeEvent(input);
        await checkTask(e.task);
        const items = await read();
        items.push(e);
        await save(items);
        const activity = await taskStore.logActivity({ actor, action: 'event', ...(e.owner && { owner: e.owner }), task: e.task, title: e.title, summary: `נוסף ללו״ז: ${eventWhen(e)}`, before: { event: null }, after: { event: e } });
        announce();
        return { event: e, activity };
      });
    },

    update(id, input, { actor = 'dashboard' } = {}) {
      return lock(async () => {
        const items = await read();
        const i = items.findIndex((x) => x.id === id);
        if (i < 0) throw notFound(`Event ${id} not found`);
        const before = items[i];
        const e = normalizeEvent(input, before);
        if (e.task !== before.task) await checkTask(e.task);
        if (same(e, before)) return { event: e, activity: null };
        items[i] = e;
        await save(items);
        const moved = before.date !== e.date || before.start !== e.start || before.end !== e.end;
        const activity = await taskStore.logActivity({ actor, action: 'event', ...(e.owner && { owner: e.owner }), task: e.task, title: e.title, summary: moved ? `לו״ז: ${eventWhen(before)} → ${eventWhen(e)}` : `לו״ז עודכן: ${summary(e)}`, before: { event: before }, after: { event: e } });
        announce();
        return { event: e, activity };
      });
    },

    remove(id, { actor = 'dashboard' } = {}) {
      return lock(async () => {
        const items = await read();
        const before = items.find((x) => x.id === id);
        if (!before) throw notFound(`Event ${id} not found`);
        await save(items.filter((x) => x.id !== id));
        const activity = await taskStore.logActivity({ actor, action: 'event', ...(before.owner && { owner: before.owner }), task: before.task, title: before.title, summary: `בוטל מהלו״ז: ${eventWhen(before)}`, before: { event: before }, after: { event: null } });
        announce();
        return { ok: true, activity };
      });
    },

    /** Scheduler bookkeeping (no activity line): compare-and-set on the occurrence it was computed for. */
    mark(id, patch, expect) {
      return lock(async () => {
        const items = await read();
        const i = items.findIndex((x) => x.id === id);
        if (i < 0 || items[i].date !== expect.date || items[i].start !== expect.start || items[i].remind !== expect.remind) return null;
        items[i] = { ...items[i], ...patch };
        await save(items);
        announce();
        return items[i];
      });
    },
  };

  // Undo: put back what was there before, unless it changed again since (then the later change must go first).
  taskStore.registerUndo('event', async (entry, { actor }) => {
    const items = await read();
    const before = entry.before?.event || null;
    const after = entry.after?.event || null;
    const id = (before || after).id;
    const current = items.find((x) => x.id === id) || null;
    const strip = (e) => e && { ...e, reminded_at: null, remind_error: null, retry_at: null, attempts: 0 };
    if (!same(strip(current), strip(after))) throw conflict('הפריט בלו״ז השתנה שוב מאז — בטל קודם את השינוי המאוחר יותר');
    const next = items.filter((x) => x.id !== id);
    if (before) next.push(before);
    await save(next);
    const activity = await taskStore.logActivity({ actor, action: 'event', ...((before || after).owner && { owner: (before || after).owner }), task: (before || after).task, title: (before || after).title, summary: `ביטול: ${entry.summary}`, before: { event: current }, after: { event: before } });
    announce();
    return { ok: true, event: before, activity };
  });

  return store;
}

/** Free gaps in a work day (08:00–18:00 by default) between the given events, ≥ minMinutes long. */
export function freeGaps(events, date, { from = '08:00', to = '18:00', minMinutes = 30, now = new Date() } = {}) {
  const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const l = local(now);
  let cursor = toMin(from);
  if (date === l.date) cursor = Math.max(cursor, l.hh * 60 + l.mm);
  const end = toMin(to);
  const gaps = [];
  for (const e of events.filter((x) => x.date === date).sort((a, b) => a.start.localeCompare(b.start))) {
    const s = toMin(e.start); const f = e.end ? toMin(e.end) : s + 30;
    if (s - cursor >= minMinutes) gaps.push([cursor, Math.min(s, end)]);
    cursor = Math.max(cursor, f);
  }
  if (end - cursor >= minMinutes) gaps.push([cursor, end]);
  const fmt = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  return gaps.filter(([a, b]) => b - a >= minMinutes).map(([a, b]) => `${fmt(a)}–${fmt(b)}`);
}
