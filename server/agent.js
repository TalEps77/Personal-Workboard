// The agent's interface to the board: a small set of typed tools served over MCP (POST /mcp, JSON-RPC 2.0,
// stateless Streamable HTTP). Built so a WhatsApp agent can do a typical request in one call:
// - answers are short Hebrew lines, never the whole board as JSON;
// - dates/times are resolved here ("מחר", "ראשון 09:30", "+90m") in the instance time zone and work week;
// - statuses/projects accept ids, labels or aliases;
// - batch writes report per item, so a partial failure never needs a blind retry.
import { agenda, categoryOf, progress } from './summary.js';
import { calendar, heDay, isWorkday, resolveAt, resolveDateInfo } from './dates.js';
import { addDays as addDaysIso } from './time.js';
import { local } from './time.js';
import { DEFAULT_LEAD, EVENT_KINDS, freeGaps, leadOf } from './events.js';
import { EFFORTS, KINDS, effortFrom, effortOfTask, focusList, kindFrom, kindOfTask } from '../public/js/focus.js';
import { DEPTS } from './shopping.js';

const PROTOCOL = '2025-06-18';
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const bad = (message) => Object.assign(new Error(message), { status: 400, code: 'invalid' });
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[׳'"`]/g, '').replace(/\s+/g, ' ');

// ---------- formatting ----------
function nowLine(now = new Date()) {
  const l = local(now);
  return `עכשיו: ${heDay(l.date, now).replace(/^היום \((.*)\)$/, '$1')} ${l.time} (שעון מקומי)`;
}
const shortDay = (date, now) => heDay(date, now).replace(/^יום /, '');

export function taskLine(task, schema, now = new Date(), { reminders = true, tag = null } = {}) {
  const status = schema.statuses.find((s) => s.id === task.status)?.label || task.status;
  const project = schema.projects.find((p) => p.id === task.project)?.name;
  const p = progress(task);
  const bits = [`#${task.id} ${task.title}`, status];
  const where = tag?.(task);
  if (where) bits.push(where);
  if (project) bits.push(`📁 ${project}`);
  if (task.when) bits.push(`עבודה: ${shortDay(task.when, now)}`);
  if (task.deadline) bits.push(`דדליין: ${shortDay(task.deadline, now)}`);
  const kind = kindOfTask(task);
  if (kind) bits.push(kind.label);
  const effort = effortOfTask(task);
  if (effort) bits.push(`⏱ ${effort.label}`);
  if (task.fields?.with) bits.push(`עם: ${task.fields.with}`);
  if (p.total) bits.push(`☑${p.done}/${p.total}`);
  if (task.priority === 'urgent' || task.priority === 'high') bits.push(task.priority === 'urgent' ? '‼️' : '❗');
  if (reminders) for (const r of task.reminders.filter((x) => !x.done)) bits.push(`⏰ ${shortDay(local(r.at).date, now)} ${local(r.at).time} [${r.id}]${r.repeat ? ` ${r.repeat}` : ''}${r.nag ? ` כל ${r.nag}ד׳` : ''}`);
  if (task.org) bits.push(task.org.gone ? '🏢 כבר לא בלוח הארגוני' : `🏢 ארגוני${task.org.role === 'reviewer' ? ' · את/ה המבקר/ת' : task.org.status === 'pending' ? ' · ממתין לאישורך בלוח הצוות' : ''}`);
  if (task.archived) bits.push('בארכיון');
  return bits.join(' · ');
}

export function reminderState(r) {
  if (r.delivery_failed && r.done) return '❌ לא נמסרה (הניסיונות הסתיימו)';
  if (r.delivery_failed) return '❌ המופע הקודם לא נמסר';
  if (!r.done && r.last_error) return `⚠️ ממתינה לניסיון חוזר${r.retry_at ? ` ב־${local(r.retry_at).time}` : ''}: ${r.last_error}`;
  if (r.done && r.sent_count > 0) return `✔ נשלחה${r.last_sent_at ? ` ${local(r.last_sent_at).time}` : ''}`;
  if (r.done) return 'הסתיימה בלי שליחה (המשימה בוצעה/בוטלה)';
  return r.sent_count > 0 ? `פעילה · נשלחה כבר ${r.sent_count} פעמים` : 'פעילה';
}

function taskDetail(task, schema, now, { notesLimit = 600, tag = null } = {}) {
  const lines = [taskLine(task, schema, now, { tag })];
  task.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s.done ? '☑' : '☐'} ${s.text}`));
  const notes = task.notes?.trim() || '';
  if (notes) lines.push(`  הערות: ${notes.slice(0, notesLimit).replace(/\n+/g, ' ⏎ ')}${notes.length > notesLimit ? ` …[נחתך: ${notesLimit}/${notes.length} תווים — find_tasks {ids:[${task.id}], detail:true} מחזיר את כולן]` : ''}`);
  const custom = Object.entries(task.fields || {}).filter(([k]) => k !== 'with');
  if (custom.length) lines.push(`  שדות: ${custom.map(([k, v]) => `${schema.fields.find((f) => f.id === k)?.label || k}=${v}`).join(' · ')}`);
  for (const r of task.reminders) {
    const l = local(r.at);
    lines.push(`  תזכורת ${r.id}: ${shortDay(l.date, now)} ${l.time}${r.note ? ` — ${r.note}` : ''}${r.repeat ? ` · ${r.repeat}` : ''}${r.nag ? ` · כל ${r.nag}ד׳` : ''} · ${reminderState(r)}`);
  }
  return lines.join('\n');
}

// ---------- resolving names ----------
function resolveStatus(schema, value) {
  if (value === undefined) return undefined;
  const v = norm(value);
  const hit = schema.statuses.find((s) => norm(s.id) === v || norm(s.label) === v)
    || ({ done: 'done', 'בוצע': 'done', doing: 'active', 'בעבודה': 'active', next: 'todo', todo: 'todo', 'הבא בתור': 'todo', someday: 'later', 'מתישהו': 'later', inbox: 'inbox' }[v] && schema.statuses.find((s) => s.category === { done: 'done', 'בוצע': 'done', doing: 'active', 'בעבודה': 'active', next: 'todo', todo: 'todo', 'הבא בתור': 'todo', someday: 'later', 'מתישהו': 'later', inbox: 'inbox' }[v]));
  if (!hit) throw bad(`Unknown status "${value}". Use one of: ${schema.statuses.map((s) => `${s.id} (${s.label})`).join(', ')}`);
  return hit.id;
}
function resolveProject(schema, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '' || norm(value) === 'none') return null;
  const v = norm(value);
  const hit = schema.projects.find((p) => norm(p.id) === v || norm(p.name) === v || (p.aliases || []).some((a) => norm(a) === v));
  if (!hit) throw bad(`Unknown project "${value}". Existing: ${schema.projects.filter((p) => !p.archived).map((p) => `${p.id} (${p.name})`).join(', ')}. Create new projects with the REST API (PATCH /api/schema).`);
  return hit.id;
}
function resolvePriority(schema, value) {
  if (value === undefined) return undefined;
  const v = norm(value);
  const map = { urgent: 'urgent', 'דחוף': 'urgent', high: 'high', 'חשוב': 'high', 'גבוה': 'high', normal: 'normal', 'רגיל': 'normal', low: 'low', 'נמוך': 'low' };
  const id = schema.priorities.find((p) => norm(p.id) === v || norm(p.label) === v)?.id || map[v];
  if (!id || !schema.priorities.some((p) => p.id === id)) throw bad(`Unknown priority "${value}". Use: ${schema.priorities.map((p) => p.id).join(', ')}`);
  return id;
}
const resolveProjectSafe = (schema, value) => { try { return resolveProject(schema, value); } catch { return null; } };
// ---------- schedule ----------
const evLead = (e) => (e.remind === -1 ? 'בלי תזכורת' : `⏰ ${leadOf(e)} דק׳ לפני${e.reminded_at ? (e.remind_error ? ` (${e.remind_error})` : ' ✔ נשלחה') : ''}`);
function eventLine(e, n, { day = true } = {}) {
  const bits = [`${day ? `${shortDay(e.date, n)} ` : ''}${e.start}${e.end ? `–${e.end}` : ''}`, e.title, EVENT_KINDS[e.kind]];
  if (e.with) bits.push(`עם: ${e.with}`);
  if (e.location) bits.push(`📍 ${e.location}`);
  if (e.task) bits.push(`#${e.task}`);
  bits.push(evLead(e));
  return `${bits.join(' · ')} [${e.id}]`;
}
/** Date + times from the agent's words: {date|day expr, start, end|minutes} or {at: "מחר 11:00", end|minutes}. */
function resolveSlot(input, n, base = null) {
  const out = {};
  if (input.at !== undefined) {
    const at = resolveAt(input.at, n);
    out.date = at.date; out.start = at.time;
  } else {
    if (input.date !== undefined) out.date = resolveDateInfo(input.date, n).date;
    if (input.start !== undefined) out.start = input.start;
  }
  if (input.minutes !== undefined) {
    const start = out.start || base?.start;
    if (!start) throw bad('minutes needs a start time');
    const [h, m] = start.split(':').map(Number); const total = h * 60 + m + input.minutes;
    if (total >= 24 * 60) throw bad('An item must end on the same day');
    out.end = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  } else if (input.end !== undefined) out.end = input.end || null;
  return out;
}
const overlaps = (a, b) => a.id !== b.id && a.date === b.date && a.start < (b.end || b.start) && b.start < (a.end || a.start);

const doneStatus = (schema) => schema.statuses.find((s) => s.category === 'done')?.id;
const dateWarn = (date, now) => (date && !isWorkday(date) ? ` ⚠️ ${shortDay(date, now)} אינו יום עבודה` : '');

// ---------- tools ----------
const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const DATE_HELP = 'Date words are resolved by the server in local time: YYYY-MM-DD, today/היום, tomorrow/מחר, next-workday, a weekday (sun…thu or ראשון…חמישי = the coming one, never today), next-week (= coming Sunday), end-of-week (= Thursday), +3d, +2w, DD.MM, or "none" to clear.';
const AT_HELP = 'Reminder time, resolved by the server in local time: +90m, +2h, +1h30m, 17:00 (today; tomorrow if already past), "tomorrow 09:30", "ראשון 09:30", "next-workday morning" (morning=09:00, noon=12:00, evening=18:00), or YYYY-MM-DDTHH:MM.';
const TASK_FIELDS = {
  title: { type: 'string' },
  space: { type: 'string', description: 'Where the task lives: work (default for new tasks), personal (private life: health, family, errands, hobbies), home (shared household with your partner: repairs, bills, kids, house). Moving a task between spaces is allowed.' },
  assignee: { type: 'string', description: 'Home tasks only — whose it is: me, partner, both, or none (unassigned). Default for a new home task: me.' },
  project: { type: 'string', description: 'Project id, name or alias. "none" to clear.' },
  status: { type: 'string', description: 'Status id or label (e.g. next/doing/waiting/someday/done or Hebrew label).' },
  priority: { type: 'string', description: 'urgent | high | normal | low' },
  when: { type: 'string', description: `Planned work day. ${DATE_HELP}` },
  deadline: { type: 'string', description: `Hard due date (תג״ב). ${DATE_HELP}` },
  with: { type: 'string', description: 'People involved (the "עם מי" field), comma separated. "" to clear.' },
  kind: { type: 'string', enum: ['solo', 'together', 'coord', 'followup', ''], description: 'Work type — set it on EVERY task: solo = hands-on work {user} does alone; together = hands-on but needs someone; coord = a call/meeting/arranging something with someone; followup = someone else does it, {user} checks. "" clears.' },
  effort: { type: 'string', description: 'Rough effort if {user} said it or it is obvious: 15m, 30m, 1h, 4h, 8h (or רבע שעה/חצי שעה/שעה/חצי יום/יום ומעלה). Empty string clears.' },
  fields: { type: 'object', description: 'Other custom fields by id or label, e.g. {"קישור": "https://…"}. "" clears one.', additionalProperties: true },
  tags: { type: 'array', items: { type: 'string' } },
  notes: { type: 'string', description: 'Replaces the notes. Prefer append_note.' },
  append_note: { type: 'string', description: 'Adds a line to the notes.' },
};
const REMIND = { type: 'object', properties: { at: { type: 'string', description: AT_HELP }, note: { type: 'string' }, repeat: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'monthly'] }, nag: { type: 'integer', minimum: 5, maximum: 1440, description: 'Re-send every N minutes until done.' } }, required: ['at'], additionalProperties: false };

const EV_FIELDS = {
  title: { type: 'string', description: 'Defaults to the linked task\'s title.' },
  at: { type: 'string', description: `Start as one phrase: "מחר 11:00", "ראשון ב-9:30", "2026-10-20T14:30". ${AT_HELP}` },
  date: { type: 'string', description: `Or the day separately. ${DATE_HELP}` },
  start: { type: 'string', description: 'HH:MM (with date).' },
  end: { type: 'string', description: 'HH:MM end time.' },
  minutes: { type: 'integer', minimum: 5, maximum: 960, description: 'Or the length instead of end.' },
  kind: { type: 'string', enum: ['meeting', 'work', 'other'], description: 'meeting = a discussion/meeting with people; work = time {user} blocked to work on something ("חלון עבודה", "זמן לעבוד על…").' },
  task: { type: 'integer', description: 'Link to the task this is about (a work block for task #12, the meeting a coordination task set up).' },
  with: { type: 'string', description: 'People attending.' },
  location: { type: 'string' },
  notes: { type: 'string' },
  space: { type: 'string', description: 'work (default) | personal (a doctor, a haircut, friends) | home (household). A linked task\'s space is used when omitted; shared:true means home.' },
  shared: { type: 'boolean', description: 'A household item for both partners (technician visit, family dinner): shows on both schedules and reminds both.' },
  remind_before: { type: 'integer', minimum: -1, maximum: 1440, description: `Minutes before start for the WhatsApp heads-up. Omit for the default (meeting ${DEFAULT_LEAD.meeting}, work ${DEFAULT_LEAD.work}); -1 = no reminder.` },
};

const lineOf = (...a) => taskLine(...a);

export const TOOLS = [
  {
    name: 'board',
    description: 'START HERE for anything time- or agenda-related. Returns in one short text: the current local date/time, the next 8 days with weekday names, statuses, projects (with aliases/goals), today\'s agenda (overdue / due today / planned today / carried over / follow-ups / in progress / later this week), and the reminders sent to WhatsApp in the last hours — when {user} answers briefly ("עוד שעה", "בוצע", "לקחתי"), they are almost always replying to the latest of those. Use it instead of running `date`.',
    inputSchema: S({ recent_hours: { type: 'integer', minimum: 1, maximum: 72, description: 'How far back to list sent reminders (default 6).' } }),
  },
  {
    name: 'find_tasks',
    description: 'Search tasks; returns one short line per task (id, title, status, project, dates, people, steps, active reminders with their ids). Set detail=true for steps/notes/all reminders (best with ≤5 results). Without filters returns all open tasks.',
    inputSchema: S({
      query: { type: 'string', description: 'Free text over title/notes/steps/tags/people, or "#12" / "12" for an id.' },
      ids: { type: 'array', items: { type: 'integer' }, description: 'Exact tasks (found even if done/archived); other filters still apply.' },
      status: { type: 'string', description: 'Status id/label; comma separated for several.' },
      project: { type: 'string' },
      with: { type: 'string', description: 'Person name (matches the "עם מי" field and text).' },
      due: { type: 'string', enum: ['overdue', 'today', 'week'] },
      kind: { type: 'string', enum: ['solo', 'together', 'coord', 'followup', 'none'], description: 'Work type; "none" = not classified yet.' },
      space: { type: 'string', description: 'work | personal | home. Default: all your spaces.' },
      include_done: { type: 'boolean', description: 'Also completed tasks.' },
      include_archived: { type: 'boolean', description: 'Also archived tasks.' },
      detail: { type: 'boolean', description: 'Steps, notes, fields, reminders. Notes are complete when ≤3 results.' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      offset: { type: 'integer', minimum: 0, description: 'For paging through long results.' },
    }),
  },
  {
    name: 'create_tasks',
    description: 'Create one or more tasks in one call (each filed into a project + status — you sort, {user} does not). Each result line says what was created, with resolved dates, or the error for that item. Warns about likely duplicates of open tasks — check before creating twice.',
    inputSchema: S({
      tasks: {
        type: 'array', minItems: 1, maxItems: 30,
        items: { type: 'object', properties: { ...TASK_FIELDS, steps: { type: 'array', items: { type: 'string' } }, remind: REMIND }, required: ['title'], additionalProperties: false },
      },
    }, ['tasks']),
  },
  {
    name: 'update_tasks',
    description: 'Change one or more tasks in one call; each item is applied atomically and reported separately. Set done=true to complete. Steps are 1-based. Only the given fields change.',
    inputSchema: S({
      updates: {
        type: 'array', minItems: 1, maxItems: 50,
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' }, ...TASK_FIELDS,
            done: { type: 'boolean' }, archived: { type: 'boolean' },
            reason: { type: 'string', description: 'Why the deadline moves. Required when moving the deadline of a team-board task (marked 🏢): it is recorded there and shown to the reviewer.' },
            expose_to_org: { type: 'boolean', description: 'true = put this personal task on the team board (one way; it becomes a managed team task). Only when the person asks.' },
            add_tags: { type: 'array', items: { type: 'string' } }, remove_tags: { type: 'array', items: { type: 'string' } },
            add_steps: { type: 'array', items: { type: 'string' } },
            check_steps: { type: 'array', items: { type: 'integer' }, description: 'Step numbers to mark done.' },
            uncheck_steps: { type: 'array', items: { type: 'integer' } },
            remove_steps: { type: 'array', items: { type: 'integer' } },
            edit_steps: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, text: { type: 'string' } }, required: ['n', 'text'], additionalProperties: false }, description: 'Reword steps in place.' },
          },
          required: ['id'], additionalProperties: false,
        },
      },
    }, ['updates']),
  },
  {
    name: 'remind',
    description: 'Set, move (snooze) or cancel a task reminder; Workboard itself sends it to WhatsApp at that time. Moving: pass reminder_id, or "latest" for the reminder that fired most recently on that task — never add a second reminder when {user} asks to postpone one. Without reminder_id a new reminder is added. Works on reminders that already fired.',
    inputSchema: S({
      task: { type: 'integer' },
      at: { type: 'string', description: AT_HELP },
      reminder_id: { type: 'string', description: 'r… id from find_tasks/board, or "latest".' },
      note: { type: 'string' },
      repeat: { type: ['string', 'null'], enum: ['daily', 'weekdays', 'weekly', 'monthly', null] },
      nag: { type: ['integer', 'null'], minimum: 5, maximum: 1440 },
      cancel: { type: 'boolean', description: 'Delete the reminder (needs reminder_id).' },
    }, ['task']),
  },
  {
    name: 'focus',
    description: '{user} has free time ("יש לי שעה פנויה", "על מה כדאי לעבוד?") → their open tasks of one work type, ranked by what is most worth doing now, each with the reasons and the next step. Same ranking as the dashboard\'s "זמן פנוי" page. mode solo = hands-on alone (default); coord = calls/coordination he can close in a few minutes.',
    inputSchema: S({ space: { type: 'string', description: 'work | personal | home; default all.' }, mode: { type: 'string', enum: ['solo', 'coord', 'together'] }, minutes: { type: 'integer', minimum: 5, maximum: 600, description: 'How much time {user} has (יש לי חצי שעה = 30): only tasks estimated to fit; unestimated ones come after.' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }),
  },
  {
    name: 'projects',
    description: 'List projects, or create/update one (name, aliases, goal, due date, color, archive). Use it when a recurring topic needs a project, or to add an alias so future matching works. Removing projects is not possible here — ask {user}.',
    inputSchema: S({
      upsert: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Existing project id/name/alias to update; omit to create.' },
          name: { type: 'string' }, add_aliases: { type: 'array', items: { type: 'string' } },
          goal: { type: 'string', description: 'One sentence: what done looks like.' },
          due: { type: 'string', description: `Target date. ${DATE_HELP}` },
          color: { type: 'string', enum: ['gray', 'accent', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'pink', 'purple'] },
          archived: { type: 'boolean' },
          space: { type: 'string', description: 'New projects: work (default) | personal | home.' },
        },
        additionalProperties: false,
      },
    }),
  },
  {
    name: 'calendar',
    description: '{user}\'s schedule (לו״ז): meetings and blocked work time they told you about, day by day, with each item\'s reminder, plus the FREE gaps (08:00–18:00) so you can suggest when something fits. Default: today and the next 6 days.',
    inputSchema: S({ from: { type: 'string', description: DATE_HELP }, days: { type: 'integer', minimum: 1, maximum: 31 } }),
  },
  {
    name: 'add_events',
    description: 'Add items to {user}\'s schedule — "קבעתי דיון עם X ביום Y בשעה Z", "שמתי מחר 13:00–13:45 זמן עבודה על המצגת". Workboard reminds them on WhatsApp before each one (default: meeting 15 min, work block 10 min; set remind_before when he asks for something else). Link work blocks to their task. Do NOT also create task reminders for the same thing. Warns about overlaps.',
    inputSchema: S({ events: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: EV_FIELDS, additionalProperties: false } } }, ['events']),
  },
  {
    name: 'update_events',
    description: 'Move, change or cancel schedule items by id (ids from calendar/board). A new time re-arms the reminder.',
    inputSchema: S({ updates: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { id: { type: 'string' }, cancel: { type: 'boolean' }, ...EV_FIELDS }, required: ['id'], additionalProperties: false } } }, ['updates']),
  },
  {
    name: 'shopping',
    description: 'The household shopping lists — all shared with the partner (both of you and both agents see them): super (supermarket, grouped by department — the default), pharm (pharmacy: medicine, cosmetics, hygiene), house (general things for the home that fit no shop: shelves, tiles, tools, furniture), personal (things one of you needs for themselves — each item shows who added it), wish (what each of you would like one day; shows who added it — "what does she want?" = the partner\'s wishes). `claim` a wish the partner added to quietly mark "I\'ll buy this" — the one who wished never sees it. Add many items in one call; duplicates merge. check / uncheck / remove by id or words; finish=true clears ticked items of `list`. Returns the list(s) asked about.',
    inputSchema: S({
      list: { type: 'string', enum: ['super', 'pharm', 'house', 'personal', 'wish'], description: 'Default list for add/finish and which list to show. Default super.' },
      add: { type: 'array', maxItems: 40, items: { type: 'object', properties: { text: { type: 'string' }, list: { type: 'string', enum: ['super', 'pharm', 'house', 'personal', 'wish'] }, qty: { type: 'string', description: 'e.g. "2", "1 ק״ג", "גדול"' }, note: { type: 'string', description: 'Brand, size, link, price…' }, dept: { type: 'string', enum: DEPTS.map((d) => d.id) } }, required: ['text'], additionalProperties: false } },
      check: { type: 'array', items: { type: 'string' }, description: 'Bought: ids (s…) or item words.' },
      uncheck: { type: 'array', items: { type: 'string' } },
      remove: { type: 'array', items: { type: 'string' } },
      move: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, dept: { type: 'string', enum: DEPTS.map((d) => d.id) }, list: { type: 'string', enum: ['super', 'pharm', 'house', 'personal', 'wish'] } }, required: ['item'], additionalProperties: false }, description: 'Fix a supermarket department (remembered) or move an item to another list.' },
      claim: { type: 'array', items: { type: 'string' }, description: 'Wishes the partner added that {user} will buy as a gift (hidden from the partner).' },
      unclaim: { type: 'array', items: { type: 'string' } },
      finish: { type: 'boolean' },
      all: { type: 'boolean', description: 'Show every list instead of one.' },
    }),
  },
  {
    name: 'history',
    description: 'Recent changes (who/what/when), each with an activity id for undo. Optionally for one task.',
    inputSchema: S({ task: { type: 'integer' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }),
  },
  {
    name: 'undo',
    description: 'Undo a change by activity id (from history or from a previous tool result). Fails with a conflict if the same field changed since.',
    inputSchema: S({ activity_id: { type: 'string' } }, ['activity_id']),
  },
];

export function createAgentTools({ taskStore: rawTasks, schemaStore: rawSchema, scheduler: rawScheduler, eventStore: rawEvents = null, access = null, shopping = null, orgSync = null }) {
  const now = () => new Date();

  function fieldChanges(schema, input, task = null, { workdays = true } = {}) {
    const out = {}; const notes = [];
    if (input.title !== undefined) out.title = input.title;
    if (input.status !== undefined) out.status = resolveStatus(schema, input.status);
    if (input.project !== undefined) out.project = resolveProject(schema, input.project);
    if (input.priority !== undefined) out.priority = resolvePriority(schema, input.priority);
    for (const key of ['when', 'deadline']) if (input[key] !== undefined) { const r = resolveDateInfo(input[key], now()); out[key] = r.date; notes.push(r.warn, workdays ? dateWarn(r.date, now()) : ''); }
    if (input.fields !== undefined || input.with !== undefined) {
      out.fields = { ...(task?.fields || {}) };
      for (const [key, value] of Object.entries(input.fields || {})) {
        const def = schema.fields.find((f) => norm(f.id) === norm(key) || norm(f.label) === norm(key));
        if (!def) throw bad(`Unknown field "${key}". Fields: ${schema.fields.map((f) => `${f.id} (${f.label})`).join(', ') || 'none'}`);
        out.fields[def.id] = value === '' ? null : value;
      }
      if (input.with !== undefined) out.fields.with = input.with || null;
    }
    if (input.effort !== undefined) {
      if (!schema.fields.some((f) => f.id === 'effort')) throw bad('The board has no "effort" field yet');
      const e = effortFrom(input.effort);
      if (input.effort && !e) throw bad(`Unknown effort "${input.effort}". Use 15m, 30m, 1h, 4h, 8h`);
      out.fields = { ...(out.fields || task?.fields || {}), effort: e ? e.label : null };
    }
    if (input.kind !== undefined) {
      if (!schema.fields.some((f) => f.id === 'kind')) throw bad('The board has no "kind" field yet — ask the board owner to add it (Settings → fields)');
      const k = kindFrom(input.kind);
      if (input.kind && !k) throw bad(`Unknown kind "${input.kind}". Use: ${KINDS.map((x) => `${x.id} (${x.label})`).join(', ')}`);
      out.fields = { ...(out.fields || task?.fields || {}), kind: k ? k.label : null };
    }
    if (input.tags !== undefined) out.tags = input.tags;
    if (input.add_tags || input.remove_tags) out.tags = [...new Set([...(out.tags || task?.tags || []), ...(input.add_tags || [])])].filter((t) => !(input.remove_tags || []).includes(t));
    if (input.notes !== undefined) out.notes = input.notes;
    if (input.append_note) out.notes = `${(out.notes ?? task?.notes ?? '').trimEnd()}${(out.notes ?? task?.notes ?? '').trim() ? '\n' : ''}${input.append_note}`;
    if (input.done === true) out.status = doneStatus(schema);
    if (input.done === false && task && categoryOf(schema, task.status) === 'done') out.status = schema.defaultStatus;
    if (input.archived !== undefined) out.archived = input.archived;
    return { out, warn: notes.join('') };
  }

  function duplicates(tasks, schema, title) {
    const words = (s) => new Set(norm(s).split(/[\s,.:;!?()\-–]+/).filter((w) => w.length > 2));
    const a = words(title);
    if (a.size < 2) return [];
    return tasks.filter((t) => categoryOf(schema, t.status) !== 'done' && !t.archived).filter((t) => {
      const b = words(t.title); const common = [...a].filter((w) => b.has(w)).length;
      return common >= 2 && common / Math.min(a.size, b.size) >= 0.6;
    });
  }

  /** The tools as one person's agent sees them: their spaces only, their schedule, their sent reminders. */
  function handlersFor(who) {
    const taskStore = who.tasks || rawTasks;
    const eventStore = who.events || rawEvents;
    const sc = who.sc || null;
    const me = sc?.user ?? null;
    // Projects of spaces you can't see are invisible here too.
    const schemaStore = { ...rawSchema, get: async () => { const x = await rawSchema.get(); return sc && !sc.all ? { ...x, projects: x.projects.filter((p) => sc.canSeeTask({ space: p.space || null })) } : x; } };
    const scheduler = { ...rawScheduler, log: (n) => rawScheduler.log(n, me ?? undefined), status: () => rawScheduler.status(me ?? undefined) };
    const multi = Boolean(access?.multi && sc && sc.spaces.length > 1);
    const kindOfSpace = (task) => access?.space(access.spaceOf(task))?.kind || 'work';
    const personName = (id) => (id === 'both' ? 'שנינו' : access?.user(id)?.name || id);
    const tag = multi ? (task) => (kindOfSpace(task) === 'home' ? `🏠 בית${task.assignee ? ` (${task.assignee === me ? 'עליי' : personName(task.assignee)})` : ''}` : kindOfSpace(task) === 'personal' ? '👤 אישי' : null) : null;
    const taskLine = (t, schema, n, opts = {}) => lineOf(t, schema, n, { tag, ...opts });
    const mine = (tasks) => (sc ? tasks.filter(sc.isMine) : tasks);
    const resolveSpace = (value) => (sc && access?.multi ? sc.resolveSpace(value) : undefined);
    const resolveAssignee = (value) => {
      if (value === undefined) return undefined;
      const v = norm(value);
      if (!v || v === 'none' || v === 'אף אחד') return null;
      if (['both', 'שנינו', 'שניהם', 'ביחד'].includes(v)) return 'both';
      if (['me', 'אני', 'עליי', 'עלי'].includes(v)) return me;
      const other = access?.users.find((u) => u.id !== me);
      if (['partner', 'בן הזוג', 'בת הזוג', 'אשתי', 'בעלי'].includes(v) && other) return other.id;
      const hit = access?.users.find((u) => norm(u.id) === v || norm(u.name) === v);
      if (!hit) throw bad(`Unknown person "${value}" (use me, partner, both or none)`);
      return hit.id;
    };
    const spaceAndAssignee = (input, out, current = null) => {
      const space = resolveSpace(input.space);
      if (space !== undefined) out.space = space;
      const assignee = resolveAssignee(input.assignee);
      if (assignee !== undefined) out.assignee = assignee;
      const target = access?.space(space ?? (current ? access.spaceOf(current) : sc?.defaultSpace()));
      if (target?.kind === 'home' && !current && out.assignee === undefined) out.assignee = me;
      if (target && target.kind !== 'home' && out.assignee) out.assignee = null;
      return out;
    };
    return {
      async board({ recent_hours: hours = 6 } = {}) {
        const n = now();
        const [schema, all, log] = await Promise.all([schemaStore.get(), taskStore.list(), scheduler.log(100)]);
        const tasks = mine(all);
        const a = agenda(tasks, schema, n);
        const out = [nowLine(n), `ימים: ${calendar(n)}`];
        if (multi) out.push(`מרחבים: ${sc.spaces.map((x) => `${x.kind === 'home' ? 'home' : x.kind}=${x.label}${x.owner ? '' : ' (משותף)'}`).join(', ')}. משימות מהבית מופיעות כאן רק אם הן עליך, על שניכם, או על אף אחד.`);
        if (shopping) { const { lists, items } = await shopping.get(who.canList || null, me); const counts = lists.map((l) => [l, items.filter((x) => x.list === l.id && !x.done).length]).filter(([, n]) => n); if (counts.length) out.push(`🛒 קניות: ${counts.map(([l, n]) => `${l.label} ${n}`).join(' · ')} (shopping)`); }
        out.push(`סטטוסים: ${schema.statuses.map((s) => `${s.id}=${s.label}`).join(', ')}`);
        const projects = schema.projects.filter((p) => !p.archived);
        if (projects.length) out.push(`פרויקטים: ${projects.map((p) => `${p.id}=${p.name}${p.aliases?.length ? ` (${p.aliases.slice(0, 3).join('/')})` : ''}${p.due ? ` יעד ${shortDay(p.due, n)}` : ''}`).join(' · ')}`);
        if (eventStore) {
          const evs = await eventStore.list({ from: local(n).date, to: local(n).date });
          const upcoming = evs.filter((e) => `${e.end || e.start}` >= local(n).time);
          if (evs.length) out.push(`\n*🗓️ הלו״ז היום* (${evs.length}${upcoming.length < evs.length ? `, ${evs.length - upcoming.length} כבר עברו` : ''})`, ...upcoming.map((e) => `• ${eventLine(e, n, { day: false })}`));
        }
        const section = (title, list) => { if (list.length) out.push(`\n*${title}* (${list.length})`, ...list.map((t) => `• ${taskLine(t, schema, n)}`)); };
        section('⚠️ באיחור (דדליין עבר)', a.overdue);
        section('📅 דדליין היום', a.dueToday);
        section('📌 מתוכנן להיום', a.planned);
        section('↩️ נגרר מימים קודמים', a.carried);
        section('👀 מעקב — ממתין לאחרים, מגיע היום', a.followups);
        section('🔥 בעבודה (בלי תאריך להיום)', a.active);
        if (a.week.length) {
          // Later this week: one compact line per day (details via find_tasks) — keeps `board` small.
          const byDay = new Map();
          for (const t of a.week) { const d = t.when && t.when > local(n).date ? t.when : t.deadline; byDay.set(d, [...(byDay.get(d) || []), t]); }
          out.push(`\n*🗓️ בהמשך השבוע* (${a.week.length})`);
          for (const d of [...byDay.keys()].sort()) out.push(`• ${shortDay(d, n)}: ${byDay.get(d).map((t) => `#${t.id} ${t.title.length > 28 ? `${t.title.slice(0, 27)}…` : t.title}`).join(' | ')}`);
        }
        if (a.reminders.length) out.push(`\n*🔔 תזכורות שעוד יישלחו היום*`, ...a.reminders.map(({ task, reminder }) => `• ${local(reminder.at).time} #${task.id} ${task.title} [${reminder.id}]`));
        if (a.inbox.length) out.push(`\n📥 לא ממוינות: ${a.inbox.map((t) => `#${t.id}`).join(', ')} — מיין אותן`);
        const failing = tasks.flatMap((t) => t.reminders.filter((r) => r.delivery_failed || (!r.done && r.last_error)).filter((r) => Date.parse(r.at) > n.getTime() - 3 * 86400_000 || !r.done).map((r) => ({ t, r })));
        if (failing.length) out.push(`\n*❌ תזכורות שלא נמסרו / ממתינות לניסיון חוזר* (${failing.length}) — ספר למשתמש, אל תניח שהגיעו:`, ...failing.map(({ t, r }) => `• #${t.id} ${t.title} [${r.id}] ${shortDay(local(r.at).date, n)} ${local(r.at).time} — ${reminderState(r)}`));
        if (!scheduler.status().configured) out.push('\n⚠️ שליחת תזכורות לווטסאפ לא מוגדרת בשרת — תזכורות לא יישלחו.');
        const since = n.getTime() - hours * 3600_000;
        const sent = log.filter((e) => e.ok && ['workboard.reminder', 'workboard.event'].includes(e.event_type) && Date.parse(e.at) >= since).slice(0, 8);
        out.push(sent.length ? `\n*📤 תזכורות שנשלחו לווטסאפ ב־${hours} השעות האחרונות* (החדשה ראשונה):` : `\nלא נשלחו תזכורות ב־${hours} השעות האחרונות.`);
        for (const e of sent) out.push(e.event_type === 'workboard.event' ? `• ${local(e.at).time} → לו״ז: ${e.title || ''} [${e.event}]${e.task ? ` (#${e.task})` : ''}` : `• ${local(e.at).time} → #${e.task} ${e.title || ''} [${e.reminder}]`);
        return out.join('\n');
      },

      async find_tasks(input = {}) {
        const n = now();
        const [schema, all] = await Promise.all([schemaStore.get(), taskStore.list({ includeArchived: true })]);
        let tasks = all;
        const idQuery = input.query?.trim().match(/^#?(\d{1,7})$/);
        const ids = new Set([...(input.ids || []).map(String), ...(idQuery ? [idQuery[1]] : [])]);
        if (ids.size) tasks = tasks.filter((t) => ids.has(t.id)); // asked for by id: shown even if done/archived
        else {
          if (!input.include_archived) tasks = tasks.filter((t) => !t.archived);
          if (!input.include_done) tasks = tasks.filter((t) => categoryOf(schema, t.status) !== 'done');
        }
        if (input.status) { const wanted = String(input.status).split(',').map((x) => resolveStatus(schema, x)); tasks = tasks.filter((t) => wanted.includes(t.status)); }
        if (input.project) { const p = resolveProject(schema, input.project); tasks = tasks.filter((t) => t.project === p); }
        if (input.with) { const w = norm(input.with); tasks = tasks.filter((t) => norm(t.fields?.with).includes(w) || norm(`${t.title} ${t.notes}`).includes(w)); }
        if (input.query && !idQuery) {
          const words = norm(input.query).split(' ').filter(Boolean);
          tasks = tasks.filter((t) => { const hay = norm(`${t.title} ${t.notes} ${t.steps.map((x) => x.text).join(' ')} ${t.tags.join(' ')} ${Object.values(t.fields || {}).join(' ')} ${schema.projects.find((p) => p.id === t.project)?.name || ''}`); return words.every((w) => hay.includes(w)); });
        }
        if (input.kind) tasks = tasks.filter((t) => (input.kind === 'none' ? !kindOfTask(t) : kindOfTask(t)?.id === input.kind));
        if (input.space && access?.multi && sc) { const id = resolveSpace(input.space); tasks = tasks.filter((t) => access.spaceOf(t) === id); }
        if (input.due) {
          const a = agenda(tasks, schema, n);
          const today = [...a.overdue, ...a.dueToday, ...a.planned, ...a.carried, ...a.followups];
          tasks = input.due === 'overdue' ? a.overdue : input.due === 'today' ? today : [...today, ...a.week];
        }
        if (!tasks.length) return `${nowLine(n)}\nלא נמצאו משימות.`;
        const offset = input.offset || 0; const limit = input.limit || 60;
        const page = tasks.slice(offset, offset + limit);
        const notesLimit = page.length <= 3 ? 20_000 : 600;
        const lines = page.map((t) => (input.detail ? taskDetail(t, schema, n, { notesLimit, tag }) : taskLine(t, schema, n)));
        const more = offset + limit < tasks.length ? ` (מוצגות ${offset + 1}–${offset + page.length}; להמשך offset:${offset + limit})` : '';
        return `${nowLine(n)}\n${tasks.length} משימות${more}:\n${lines.join(input.detail ? '\n\n' : '\n')}`;
      },

      async create_tasks({ tasks: items }) {
        const n = now();
        const schema = await schemaStore.get();
        const existing = await taskStore.list();
        const out = [];
        for (const [i, item] of items.entries()) {
          try {
            const target = access?.space(resolveSpace(item.space) ?? sc?.defaultSpace());
            const { out: fields, warn } = fieldChanges(schema, item, null, { workdays: !target || target.kind === 'work' });
            spaceAndAssignee(item, fields);
            if (item.steps) fields.steps = item.steps;
            let reminderNote = '';
            if (item.remind) {
              const at = resolveAt(item.remind.at, n);
              fields.reminders = [{ at: at.iso, note: item.remind.note || '', repeat: item.remind.repeat || null, nag: item.remind.nag || null }];
              reminderNote = ` · ⏰ ${at.label}`;
            }
            const dups = duplicates(existing, schema, item.title);
            const task = await taskStore.create(fields, { actor: this.actor });
            existing.push(task);
            out.push(`✅ נוצרה ${taskLine(task, schema, n, { reminders: false })}${reminderNote}${warn}${dups.length ? ` ⚠️ אולי כפולה של ${dups.map((d) => `#${d.id} "${d.title}"`).join(', ')}` : ''}`);
          } catch (error) {
            out.push(`❌ פריט ${i + 1} ("${item.title}"): ${error.message}`);
          }
        }
        return out.join('\n');
      },

      async update_tasks({ updates }) {
        const n = now();
        const schema = await schemaStore.get();
        const out = [];
        for (const u of updates) {
          try {
            let warn = ''; let activity = null;
            if (u.reason) orgSync?.setReason(String(u.id), u.reason);
            const task = await taskStore.update(String(u.id), (current) => {
              const target = access?.space(resolveSpace(u.space) ?? access.spaceOf(current));
              const { out: changes, warn: w } = fieldChanges(schema, u, current, { workdays: !target || target.kind === 'work' });
              spaceAndAssignee(u, changes, current);
              warn = w;
              if (u.add_steps || u.check_steps || u.uncheck_steps || u.remove_steps || u.edit_steps) {
                const steps = current.steps.map((x) => ({ ...x }));
                const at = (k) => { if (!steps[k - 1]) throw bad(`Step ${k} does not exist (task #${current.id} has ${steps.length})`); return steps[k - 1]; };
                (u.check_steps || []).forEach((k) => { at(k).done = true; });
                (u.uncheck_steps || []).forEach((k) => { at(k).done = false; });
                (u.edit_steps || []).forEach(({ n: k, text }) => { at(k).text = text; });
                const remove = new Set((u.remove_steps || []).map((k) => { at(k); return k - 1; }));
                changes.steps = [...steps.filter((_, j) => !remove.has(j)), ...(u.add_steps || []).map((text) => ({ text, done: false }))];
              }
              return changes;
            }, { actor: this.actor, onActivity: (entry) => { activity = entry; } });
            if (u.expose_to_org) {
              if (!orgSync?.configuredFor(me ?? access?.people?.defaultUser ?? 'me')) throw bad('No team board is connected for this person');
              const team = await orgSync.expose(me ?? access?.people?.defaultUser ?? 'me', String(u.id));
              out.push(`🏢 #${u.id} נחשפה ללוח הארגוני (#${team.id} שם)${team.status === 'pending' ? ' — ממתינה לאישור' : ''}`);
              if (!activity) continue;
            }
            out.push(activity
              ? `✅ ${taskLine(task, schema, n)} (שונה: ${activity.summary}; undo: ${activity.id})${warn}`
              : `➖ #${task.id} ${task.title}: לא היה מה לשנות — הכול כבר כך (אין undo)${warn}`);
          } catch (error) {
            out.push(`❌ #${u.id}: ${error.message}`);
          }
        }
        return out.join('\n');
      },

      async remind(input) {
        const n = now();
        const id = String(input.task);
        const task = await taskStore.get(id);
        const schema = await schemaStore.get();
        if (!input.cancel && (task.archived || categoryOf(schema, task.status) === 'done')) throw bad(`Task #${id} is ${task.archived ? 'archived' : 'done'} — a reminder would never be sent. Reopen it first (update_tasks done:false / archived:false) if the person wants one.`);
        let rid = input.reminder_id;
        if (rid === 'latest') {
          const fired = task.reminders.filter((r) => r.last_sent_at).sort((a, b) => b.last_sent_at.localeCompare(a.last_sent_at))[0];
          rid = fired?.id || (task.reminders.length === 1 ? task.reminders[0].id : undefined);
          if (!rid) throw bad(`Task #${id} has no reminder that fired; pass reminder_id (${task.reminders.map((r) => r.id).join(', ') || 'none'}) or omit it to add one`);
        }
        if (input.cancel) {
          if (!rid) throw bad('cancel needs reminder_id');
          await taskStore.changeReminder(id, rid, null, { actor: this.actor });
          return `🗑️ התזכורת ${rid} של #${id} ${task.title} בוטלה.`;
        }
        const change = {};
        let label = '';
        if (input.at !== undefined) { const at = resolveAt(input.at, n); change.at = at.iso; label = at.label; }
        if (input.note !== undefined) change.note = input.note;
        if (input.repeat !== undefined) change.repeat = input.repeat;
        if (input.nag !== undefined) change.nag = input.nag;
        if (rid) {
          if (change.at) change.done = false; // moving a reminder that already fired re-arms it
          const updated = await taskStore.changeReminder(id, rid, change, { actor: this.actor });
          const r = updated.reminders.find((x) => x.id === rid);
          return `⏰ הוזזה: #${id} ${task.title} → ${label || `${shortDay(local(r.at).date, n)} ${local(r.at).time}`} [${rid}]${r.note ? ` — ${r.note}` : ''}`;
        }
        if (!change.at) throw bad('A new reminder needs "at"');
        const { reminder } = await taskStore.addReminder(id, change, { actor: this.actor });
        const others = task.reminders.filter((r) => !r.done);
        return `⏰ נקבעה: #${id} ${task.title} → ${label} [${reminder.id}]${reminder.note ? ` — ${reminder.note}` : ''}${others.length ? ` ⚠️ למשימה יש עוד תזכורת פעילה: ${others.map((r) => `${r.id} ${shortDay(local(r.at).date, n)} ${local(r.at).time}`).join(', ')} — אם התכוונת להזיז אותה, בטל אחת מהן` : ''}`;
      },

      async focus({ mode = 'solo', limit = 5, minutes, space } = {}) {
        const n = now();
        const [schema, all] = await Promise.all([schemaStore.get(), taskStore.list()]);
        const spaceId = space && access?.multi && sc ? resolveSpace(space) : null;
        const tasks = mine(all).filter((t) => !spaceId || access.spaceOf(t) === spaceId);
        const ranked = focusList(tasks, schema, local(n).date, { kinds: [mode], maxMinutes: minutes || null });
        const label = KINDS.find((k) => k.id === mode).label;
        const unclassified = tasks.filter((t) => !kindOfTask(t) && !['done', 'inbox'].includes(categoryOf(schema, t.status))).length;
        const lines = [nowLine(n), `*${label}${minutes ? ` — מה נכנס ב־${minutes} דק׳` : ''} — מהכי כדאי:*`];
        if (!ranked.length) lines.push('אין משימות פתוחות מהסוג הזה.');
        ranked.slice(0, limit).forEach((r, i) => lines.push(`${i + 1}. #${r.task.id} ${r.task.title}${r.why.length ? ` — ${r.why.join(', ')}` : ''}${r.nextStep ? ` · הצעד הבא: ${r.nextStep}` : ''}${r.later ? ' (מתישהו)' : ''}`));
        if (ranked.length > limit) lines.push(`…ועוד ${ranked.length - limit}`);
        if (unclassified) lines.push(`⚠️ ${unclassified} משימות פתוחות בלי סוג עבודה — סווג אותן (update_tasks kind) כדי שיופיעו כאן.`);
        return lines.join('\n');
      },

      async projects({ upsert } = {}) {
        const n = now();
        const tasks = await taskStore.list();
        const fmt = (schema) => schema.projects.map((p) => `• ${p.id} = ${p.name}${p.archived ? ' (בארכיון)' : ''}${p.aliases?.length ? ` · כינויים: ${p.aliases.join(', ')}` : ''}${p.goal ? ` · יעד: ${p.goal}` : ''}${p.due ? ` · עד ${shortDay(p.due, n)}` : ''} · ${tasks.filter((t) => t.project === p.id && categoryOf(schema, t.status) !== 'done').length} פתוחות`).join('\n') || 'אין פרויקטים.';
        if (!upsert) return fmt(await schemaStore.get());
        for (let attempt = 0; ; attempt += 1) {
          const schema = await schemaStore.get();
          // Write back the full list: projects of spaces this person can't see stay exactly as they are.
          const projects = (await rawSchema.get()).projects.map((p) => ({ ...p }));
          let target = upsert.id !== undefined ? projects.find((p) => p.id === resolveProject(schema, upsert.id)) : null;
          let created = false;
          if (!target) {
            if (!upsert.name) throw bad('A new project needs a name');
            if (resolveProjectSafe(schema, upsert.name)) throw bad(`Project "${upsert.name}" already exists — pass it as id to update it`);
            const slug = norm(upsert.name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `p${Date.now().toString(36).slice(-4)}`;
            let id = slug; let k = 2; while (projects.some((p) => p.id === id)) id = `${slug}-${k++}`;
            const space = resolveSpace(upsert.space) ?? sc?.defaultSpace();
            target = { id, name: upsert.name, color: upsert.color || 'teal', aliases: [], goal: '', due: null, milestones: [], archived: false, ...(space && space !== access?.people.defaultSpace && { space }) };
            projects.push(target); created = true;
          }
          if (upsert.name !== undefined) target.name = upsert.name;
          if (upsert.add_aliases) target.aliases = [...new Set([...(target.aliases || []), ...upsert.add_aliases])];
          if (upsert.goal !== undefined) target.goal = upsert.goal;
          if (upsert.due !== undefined) target.due = resolveDateInfo(upsert.due, n).date;
          if (upsert.color !== undefined) target.color = upsert.color;
          if (upsert.archived !== undefined) target.archived = upsert.archived;
          try {
            const saved = await rawTasks.changeSchema('patch', { projects, rev: schema.rev }, { actor: this.actor });
            const p = saved.projects.find((x) => x.id === target.id);
            return `${created ? '✅ נוצר פרויקט' : '✅ עודכן פרויקט'} ${p.id} = ${p.name}${p.aliases?.length ? ` · כינויים: ${p.aliases.join(', ')}` : ''}${p.goal ? ` · יעד: ${p.goal}` : ''}${p.due ? ` · עד ${shortDay(p.due, n)}` : ''}`;
          } catch (error) {
            if (error.status === 409 && attempt < 2) continue; // someone changed the structure meanwhile: re-read and re-apply
            throw error;
          }
        }
      },

      async calendar({ from, days = 7 } = {}) {
        const n = now();
        const start = from ? resolveDateInfo(from, n).date : local(n).date;
        const dates = Array.from({ length: days }, (_, i) => addDaysIso(start, i));
        const events = await eventStore.list({ from: dates[0], to: dates[dates.length - 1] });
        const out = [nowLine(n)];
        for (const d of dates) {
          const todays = events.filter((e) => e.date === d);
          if (!todays.length && !isWorkday(d)) continue;
          out.push(`\n*${shortDay(d, n)}*${isWorkday(d) ? '' : ' (לא יום עבודה)'}`);
          todays.forEach((e) => out.push(`• ${eventLine(e, n, { day: false })}`));
          if (isWorkday(d)) { const gaps = freeGaps(events, d, { now: n }); out.push(gaps.length ? `  פנוי: ${gaps.join(', ')}` : '  אין חלון פנוי של חצי שעה'); }
        }
        return out.join('\n');
      },

      async add_events({ events: items }) {
        const n = now();
        const out = [];
        for (const [i, input] of items.entries()) {
          try {
            const slot = resolveSlot(input, n);
            if (!slot.date || !slot.start) throw bad('Needs a start: "at" ("מחר 11:00") or date + start');
            let title = input.title;
            if (!title && input.task) title = (await taskStore.get(String(input.task))).title;
            const { event: e, activity } = await eventStore.create({ title, ...slot, ...(input.shared && { owner: 'home' }), ...(input.space && { space: resolveSpace(input.space) }), kind: input.kind || 'meeting', task: input.task ?? null, with: input.with, location: input.location, notes: input.notes, remind: input.remind_before ?? null }, { actor: this.actor });
            const clash = (await eventStore.list({ from: e.date, to: e.date })).filter((x) => overlaps(e, x));
            out.push(`✅ ${eventLine(e, n)} (undo: ${activity.id})${clash.length ? ` ⚠️ חופף ל: ${clash.map((x) => `${x.start} ${x.title}`).join(', ')}` : ''}`);
          } catch (error) { out.push(`❌ פריט ${i + 1} ("${input.title || input.at || ''}"): ${error.message}`); }
        }
        return out.join('\n');
      },

      async update_events({ updates }) {
        const n = now();
        const out = [];
        for (const u of updates) {
          try {
            if (u.cancel) { const { activity } = await eventStore.remove(u.id, { actor: this.actor }); out.push(`🗑️ ${u.id} בוטל (undo: ${activity.id})`); continue; }
            const base = await eventStore.get(u.id);
            const slot = resolveSlot(u, n, base);
            // Moving the start keeps the length unless a new end/length was given.
            if (slot.start && slot.end === undefined && base.end) {
              const len = (Number(base.end.slice(0, 2)) * 60 + Number(base.end.slice(3))) - (Number(base.start.slice(0, 2)) * 60 + Number(base.start.slice(3)));
              Object.assign(slot, resolveSlot({ minutes: len }, n, { start: slot.start }));
            }
            const changes = { ...slot };
            if (u.shared !== undefined) changes.owner = u.shared ? 'home' : me;
            if (u.space !== undefined) changes.space = resolveSpace(u.space) ?? null;
            for (const [k, v] of [['title', u.title], ['kind', u.kind], ['task', u.task], ['with', u.with], ['location', u.location], ['notes', u.notes], ['remind', u.remind_before]]) if (v !== undefined) changes[k] = v;
            const { event: e, activity } = await eventStore.update(u.id, changes, { actor: this.actor });
            const clash = (await eventStore.list({ from: e.date, to: e.date })).filter((x) => overlaps(e, x));
            out.push(`${activity ? '✅' : '➖'} ${eventLine(e, n)}${activity ? ` (undo: ${activity.id})` : ' — לא היה מה לשנות'}${clash.length ? ` ⚠️ חופף ל: ${clash.map((x) => `${x.start} ${x.title}`).join(', ')}` : ''}`);
          } catch (error) { out.push(`❌ ${u.id}: ${error.message}`); }
        }
        return out.join('\n');
      },

      async shopping(input = {}) {
        if (!shopping) throw bad('No shopping lists here');
        const can = who.canList || null;
        const canW = who.canWrite || null;
        const self = me || access?.people.defaultUser || 'me';
        const listId = (name) => { const id = name || 'super'; if (!shopping.listOf(id)) throw bad(`Unknown list "${name}"`); return id; };
        const label = (id) => shopping.listOf(id)?.label || id;
        const out = [];
        const all = async () => (await shopping.get(can, self)).items;
        const find = (list, ref) => {
          const r = norm(ref);
          return list.find((x) => x.id === ref) || list.find((x) => norm(x.text) === r) || list.filter((x) => norm(x.text).includes(r)).sort((a, b) => a.text.length - b.text.length)[0];
        };
        const main = listId(input.list);
        if (input.add?.length) {
          const items = input.add.map((x) => ({ ...x, list: listId(x.list || input.list) }));
          for (const { item, status } of await shopping.add(items, { user: me, can: canW })) out.push(`${status === 'added' ? '➕' : status === 'reopened' ? '↩️' : '➖ כבר ברשימה:'} ${item.text}${item.qty ? ` (${item.qty})` : ''} → ${label(item.list)}${item.dept ? ` · ${DEPTS.find((d) => d.id === item.dept)?.label}` : ''}`);
        }
        for (const [key, done] of [['check', true], ['uncheck', false]]) {
          for (const ref of input[key] || []) {
            const hit = find(await all(), ref);
            if (!hit) { out.push(`❌ לא נמצא: ${ref}`); continue; }
            await shopping.update(hit.id, { done }, { can: canW });
            out.push(`${done ? '✔' : '☐'} ${hit.text} (${label(hit.list)})`);
          }
        }
        for (const ref of input.remove || []) {
          const hit = find(await all(), ref);
          if (!hit) { out.push(`❌ לא נמצא: ${ref}`); continue; }
          await shopping.remove(hit.id, { can: canW });
          out.push(`🗑️ ${hit.text} (${label(hit.list)})`);
        }
        for (const mv of input.move || []) {
          const hit = find(await all(), mv.item);
          if (!hit) { out.push(`❌ לא נמצא: ${mv.item}`); continue; }
          const patch = { ...(mv.list && { list: listId(mv.list) }), ...(mv.dept && { dept: mv.dept }) };
          const it = await shopping.update(hit.id, patch, { can: canW });
          out.push(`↪️ ${it.text} → ${label(it.list)}${it.dept ? ` · ${DEPTS.find((d) => d.id === it.dept)?.label}` : ''}`);
        }
        for (const [key, on] of [['claim', true], ['unclaim', false]]) {
          for (const ref of input[key] || []) {
            const hit = find((await all()).filter((x) => x.list === 'wish' && x.by !== self), ref);
            if (!hit) { out.push(`❌ לא נמצא ב־Wish של בן/בת הזוג: ${ref}`); continue; }
            await shopping.claim(hit.id, self, on, { can });
            out.push(on ? `🤫 ${hit.text} — סומן שאתה קונה (רק אתה רואה את זה)` : `↩️ ${hit.text} — הסימון הוסר`);
          }
        }
        if (input.finish) { const done = await shopping.finish(main, { can: canW }); out.push(`🧾 ${label(main)}: ${done.length} פריטים שנקנו ירדו מהרשימה`); }
        const { lists, items } = await shopping.get(can, self);
        const listName = (l) => l.label;
        const show = input.all ? lists : lists.filter((l) => l.id === main);
        for (const l of show) {
          const open = items.filter((x) => x.list === l.id && !x.done);
          const ticked = items.filter((x) => x.list === l.id && x.done).length;
          const fmt = (x) => `${x.text}${x.qty ? ` (${x.qty})` : ''}${l.byline && x.by ? ` · ${x.by === self ? 'שלך' : `של ${personName(x.by)}`}` : ''}${x.note ? ` — ${x.note}` : ''}${x.claimed_by ? (x.claimed_by === self ? ' 🤫 אתה קונה' : ` 🤫 ${personName(x.claimed_by)} קונה`) : ''} [${x.id}]`;
          const body = l.depts
            ? DEPTS.map((d) => { const inD = open.filter((x) => x.dept === d.id); return inD.length ? `${d.icon} ${d.label}: ${inD.map(fmt).join(' · ')}` : null; }).filter(Boolean).join('\n')
            : open.map((x) => `• ${fmt(x)}`).join('\n');
          out.push(`\n*${l.icon} ${listName(l)}* (${open.length}${ticked ? `, ${ticked} סומנו` : ''})${l.wish ? ' — סימוני "אני קונה" נסתרים ממי שביקש' : ''}${open.length ? `\n${body}` : ' — ריקה'}`);
        }
        if (!input.all) { const others = lists.filter((l) => l.id !== main).map((l) => `${listName(l)} ${items.filter((x) => x.list === l.id && !x.done).length}`).join(' · '); if (others) out.push(`רשימות נוספות: ${others}`); }
        return out.join('\n').trim();
      },

      async history({ task, limit = 15 } = {}) {
        const items = await taskStore.activity({ limit, task: task ? String(task) : undefined });
        if (!items.length) return 'אין שינויים.';
        return items.map((a) => `${local(a.at).date.slice(5)} ${local(a.at).time} ${a.actor}: ${a.task ? `#${a.task} ${a.title || ''} — ` : ''}${a.summary || a.action}${a.undoable ? ` [undo: ${a.id}]` : ''}`).join('\n');
      },

      async undo({ activity_id: id }) {
        const result = await taskStore.undo(id, { actor: this.actor });
        return result?.schema ? `↩️ שינוי המבנה ${id} בוטל.` : `↩️ בוטל ${id}${result?.id ? ` (משימה #${result.id})` : ''}.`;
      },
      };
  }

  async function call(name, args, who) {
    const handlers = handlersFor(who);
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
    if (!handler) throw Object.assign(new Error(`Unknown tool ${name}`), { rpc: -32602 });
    return handler.call({ actor: who.actor }, args || {});
  }

  /** One JSON-RPC message → response object (or null for notifications). */
  async function rpc(msg, who) {
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const error = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(-32600, 'Invalid Request');
    const isNotification = msg.id === undefined;
    try {
      switch (msg.method) {
        case 'initialize': {
          const asked = msg.params?.protocolVersion;
          return reply({
            protocolVersion: SUPPORTED.includes(asked) ? asked : PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'workboard', version: '1.0.0' },
            instructions: 'Task board: work, personal and shared-home tasks, the schedule and the shared shopping list. Call `board` first for the current time, the calendar, the agenda and recently sent reminders. All answers are short Hebrew text; dates/times are resolved by the server.',
          });
        }
        case 'ping': return reply({});
        case 'tools/list': {
          // Descriptions say {user}; each agent gets them about its own person (by name), or "the user".
          const name = (who?.sc?.user && access?.user(who.sc.user)?.name) || 'the user';
          return reply({ tools: JSON.parse(JSON.stringify(TOOLS).replaceAll('{user}', name)) });
        }
        case 'tools/call': {
          try {
            const text = await call(msg.params?.name, msg.params?.arguments, who);
            return reply({ content: [{ type: 'text', text }] });
          } catch (e) {
            if (e.rpc) return error(e.rpc, e.message);
            // Tool-level failures go back to the model as text it can act on.
            return reply({ content: [{ type: 'text', text: `❌ ${e.message}${e.status === 409 ? ' (קונפליקט — קרא שוב ונסה)' : ''}` }], isError: true });
          }
        }
        default:
          if (isNotification) return null;
          return error(-32601, `Method not found: ${msg.method}`);
      }
    } catch (e) {
      return error(-32603, e.message);
    }
  }

  return { rpc, call, handlers: handlersFor({}), handlersFor };
}
