// Shared "what's on my plate" logic: the agent's /api/summary, the morning digest, and reminder texts.
import { addDays, heDate, heDateTime, local, today } from './time.js';
import { WEEK_END } from './locale.js';

export function categoryOf(schema, status) {
  return schema.statuses.find((s) => s.id === status)?.category || 'todo';
}

/** "Waiting for someone" — tracked as a follow-up, never part of the person's own to-do for today. */
export const isWaiting = (schema, status) => { const s = schema.statuses.find((x) => x.id === status); return Boolean(s) && s.category !== 'done' && (s.id === 'waiting' || /ממתין|waiting/i.test(s.label)); };

/**
 * What today actually holds — one definition for the dashboard, the digest, /api/summary and the agent:
 * overdue (deadline passed) · dueToday (deadline today) · planned (work day = today) · carried (work day already
 * passed, still open) · followups (waiting on someone, and its date has come) · active (in progress, no date today)
 * · week (planned or due later this work week). Waiting work never counts as the person's own work for today.
 */
export function agenda(tasks, schema, now = new Date()) {
  const t = today(now);
  let weekEnd = t; while (new Date(`${weekEnd}T12:00:00Z`).getUTCDay() !== WEEK_END) weekEnd = addDays(weekEnd, 1);
  const rank = (x) => schema.priorities.find((p) => p.id === x.priority)?.rank ?? 9;
  const byPriority = (a, b) => rank(a) - rank(b) || (a.deadline || '9').localeCompare(b.deadline || '9') || Number(a.id) - Number(b.id);
  const open = tasks.filter((x) => !x.archived && categoryOf(schema, x.status) !== 'done' && categoryOf(schema, x.status) !== 'inbox');
  const taken = new Set();
  const pick = (pred) => open.filter((x) => !taken.has(x) && pred(x)).sort(byPriority).map((x) => { taken.add(x); return x; });
  const waiting = (x) => isWaiting(schema, x.status);
  const out = {};
  out.overdue = pick((x) => !waiting(x) && x.deadline && x.deadline < t);
  out.followups = pick((x) => waiting(x) && ((x.when && x.when <= t) || (x.deadline && x.deadline <= t)));
  out.dueToday = pick((x) => !waiting(x) && x.deadline === t);
  out.planned = pick((x) => !waiting(x) && x.when === t);
  out.carried = pick((x) => !waiting(x) && x.when && x.when < t);
  out.active = pick((x) => !waiting(x) && categoryOf(schema, x.status) === 'active' && !(x.when && x.when > t));
  out.week = pick((x) => (x.when && x.when > t && x.when <= weekEnd) || (x.deadline && x.deadline > t && x.deadline <= weekEnd));
  out.inbox = tasks.filter((x) => !x.archived && categoryOf(schema, x.status) === 'inbox');
  out.reminders = tasks.filter((x) => !x.archived && categoryOf(schema, x.status) !== 'done').flatMap((x) => x.reminders.filter((r) => !r.done && local(r.at).date <= t && Date.parse(r.at) >= now.getTime() - 60_000).map((r) => ({ task: x, reminder: r }))).sort((a, b) => a.reminder.at.localeCompare(b.reminder.at));
  return out;
}

export const progress = (task) => ({ done: task.steps.filter((s) => s.done).length, total: task.steps.length });

export function buckets(tasks, schema, now = new Date()) {
  const t = today(now);
  const open = tasks.filter((x) => !x.archived && !['done'].includes(categoryOf(schema, x.status)));
  const rank = (x) => schema.priorities.find((p) => p.id === x.priority)?.rank ?? 9;
  const byPriority = (a, b) => rank(a) - rank(b) || (a.deadline || '9').localeCompare(b.deadline || '9');
  return {
    overdue: open.filter((x) => x.deadline && x.deadline < t).sort(byPriority),
    today: open.filter((x) => (x.when && x.when <= t) || x.deadline === t).filter((x) => !(x.deadline && x.deadline < t)).sort(byPriority),
    active: open.filter((x) => categoryOf(schema, x.status) === 'active').sort(byPriority),
    inbox: open.filter((x) => categoryOf(schema, x.status) === 'inbox').sort(byPriority),
    next: open.filter((x) => categoryOf(schema, x.status) === 'todo').sort(byPriority),
    reminders: open.flatMap((x) => x.reminders.filter((r) => !r.done && local(r.at).date <= t).map((r) => ({ task: x, reminder: r }))).sort((a, b) => a.reminder.at.localeCompare(b.reminder.at)),
    doneToday: tasks.filter((x) => x.completed_at && local(x.completed_at).date === t),
    open,
  };
}

/** Marks tasks outside work when one list mixes spaces: 🏠 shared home, 👤 personal. */
export const spaceTagger = (spaces, defaultSpace = 'work') => {
  if (!spaces || spaces.length < 2) return () => '';
  const kind = new Map(spaces.map((s) => [s.id, s.kind]));
  return (task) => ({ home: '🏠 ', personal: '👤 ' }[kind.get(task.space || defaultSpace)] || '');
};

export function line(task, schema, now = new Date(), tag = () => '') {
  const p = progress(task);
  const bits = [`#${task.id} ${tag(task)}${task.title}`];
  const status = schema.statuses.find((s) => s.id === task.status)?.label;
  if (status) bits.push(`[${status}]`);
  if (p.total) bits.push(`☑ ${p.done}/${p.total}`);
  if (task.deadline) bits.push(`📅 ${heDate(task.deadline, now)}`);
  const project = schema.projects.find((x) => x.id === task.project)?.name;
  if (project) bits.push(`📁 ${project}`);
  return bits.join(' · ');
}

export function summaryText(tasks, schema, now = new Date(), tag = () => '') {
  const a = agenda(tasks, schema, now);
  const section = (title, list, max = 8) => (list.length ? [`*${title}* (${list.length})`, ...list.slice(0, max).map((x) => `• ${line(x, schema, now, tag)}`), list.length > max ? `  …ועוד ${list.length - max}` : null].filter(Boolean).join('\n') : null);
  const parts = [
    section('⚠️ באיחור', a.overdue),
    section('📅 דדליין היום', a.dueToday),
    section('📌 להיום', [...a.planned, ...a.carried]),
    section('👀 מעקב היום', a.followups),
    section('🔥 בעבודה', a.active, 5),
    a.reminders.length ? [`*🔔 תזכורות היום* (${a.reminders.length})`, ...a.reminders.map(({ task, reminder }) => `• ${heDateTime(reminder.at, now).replace('היום ', '')} — #${task.id} ${task.title}`)].join('\n') : null,
    a.inbox.length ? `*📥 לא ממוין:* ${a.inbox.length}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join('\n\n') : 'אין כרגע משימות פתוחות להיום 🎉';
}

export function reminderText(task, reminder, schema, { late = false, now = new Date() } = {}) {
  const p = progress(task);
  const nextStep = task.steps.find((s) => !s.done);
  const lines = [
    // Repeated nags escalate visibly (gradual escalation on follow-ups).
    reminder.sent_count > 0 ? `🔁 *תזכורת חוזרת (${reminder.sent_count + 1})* · משימה #${task.id}` : `⏰ *תזכורת${late ? ' (באיחור)' : ''}* · משימה #${task.id}`,
    `*${task.title}*`,
    reminder.note ? `📝 ${reminder.note}` : null,
    p.total ? `☑️ שלבים ${p.done}/${p.total}${nextStep ? ` — הבא: ${nextStep.text}` : ''}` : null,
    task.deadline ? `📅 דדליין: ${heDate(task.deadline, now)}` : null,
    reminder.nag ? `🔁 אזכיר שוב בעוד ${reminder.nag} דק׳ עד שתסמן בוצע` : null,
    schema.publicUrl ? `🔗 ${schema.publicUrl}/#/task/${task.id}` : null,
    `_אפשר לענות: "בוצע ${task.id}" או "תדחה ${task.id} בשעה"_`,
  ];
  return lines.filter(Boolean).join('\n');
}

export function digestText(tasks, schema, now = new Date(), events = [], { spaces = null, defaultSpace = 'work' } = {}) {
  const agendaLines = events.length ? `*🗓️ הלו״ז היום*\n${events.map((e) => `• ${e.start}${e.end ? `–${e.end}` : ''} ${e.title}${e.with ? ` (${e.with})` : ''}`).join('\n')}\n\n` : '';
  return `☀️ *בוקר טוב! סיכום Workboard ל${heDate(today(now), now) === 'היום' ? 'היום' : today(now)}*\n\n${agendaLines}${summaryText(tasks, schema, now, spaceTagger(spaces, defaultSpace))}${schema.publicUrl ? `\n\n🔗 ${schema.publicUrl}` : ''}`;
}
