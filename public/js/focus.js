// "What should I work on?" — shared by the dashboard (the "זמן פנוי" page) and the agent (server/agent.js imports it),
// so the person and their agent always get the same answer. Pure functions: no DOM, no state.

/** The work-type field: one value per task, stored as its Hebrew label in task.fields.kind. */
export const KIND_FIELD = { id: 'kind', label: 'סוג עבודה', type: 'select', showOnCard: false };
export const KINDS = [
  { id: 'solo', label: 'עבודה עצמאית', short: 'לבד', icon: 'user', hint: 'ביצוע בפועל — רק אני' },
  { id: 'together', label: 'עבודה משותפת', short: 'עם מישהו', icon: 'users', hint: 'ביצוע בפועל, צריך עוד מישהו' },
  { id: 'coord', label: 'תיאום', short: 'תיאום', icon: 'chat', hint: 'שיחה, פגישה, לסגור משהו מול מישהו' },
  { id: 'followup', label: 'מעקב', short: 'מעקב', icon: 'eye', hint: 'מישהו אחר מבצע — אני בודק' },
];
KIND_FIELD.options = KINDS.map((k) => k.label);

/** Rough effort, so "I have half an hour" can filter. Stored as the label in task.fields.effort. */
export const EFFORT_FIELD = { id: 'effort', label: 'משך', type: 'select', showOnCard: false };
export const EFFORTS = [
  { label: 'רבע שעה', minutes: 15 }, { label: 'חצי שעה', minutes: 30 }, { label: 'שעה', minutes: 60 },
  { label: 'חצי יום', minutes: 240 }, { label: 'יום ומעלה', minutes: 480 },
];
EFFORT_FIELD.options = EFFORTS.map((e) => e.label);
/** Minutes, an EFFORTS label, or "15m"/"1h" → the matching effort (rounded up to the next bucket). */
export function effortFrom(value) {
  if (value === undefined || value === null || value === '') return null;
  const byLabel = EFFORTS.find((e) => e.label === String(value).trim());
  if (byLabel) return byLabel;
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|דק|h|hour|שעה|שעות)?/i);
  if (!m) return null;
  const minutes = Number(m[1]) * (/^(h|hour|שע)/i.test(m[2] || '') ? 60 : 1);
  return EFFORTS.find((e) => e.minutes >= minutes) || EFFORTS[EFFORTS.length - 1];
}
export const effortOfTask = (task) => effortFrom(task?.fields?.effort);

const ALIASES = { solo: 'solo', 'לבד': 'solo', 'עצמאי': 'solo', 'עצמאית': 'solo', 'hands-on': 'solo', together: 'together', 'משותף': 'together', 'משותפת': 'together', 'עם מישהו': 'together', coord: 'coord', coordination: 'coord', 'תיאום': 'coord', followup: 'followup', 'follow-up': 'followup', 'מעקב': 'followup' };
/** id, Hebrew label or alias → the kind object (or null). */
export function kindFrom(value) {
  if (value === undefined || value === null || value === '') return null;
  const v = String(value).trim().toLowerCase();
  return KINDS.find((k) => k.id === v || k.label === String(value).trim()) || KINDS.find((k) => k.id === ALIASES[v]) || null;
}
export const kindOfTask = (task) => kindFrom(task?.fields?.kind);

const dayDiff = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 864e5);
const HE_DOW = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const dayName = (date, today) => {
  const d = dayDiff(date, today);
  if (d === 0) return 'היום';
  if (d === 1) return 'מחר';
  return `${HE_DOW[new Date(`${date}T12:00:00Z`).getUTCDay()]} ${Number(date.slice(8))}.${Number(date.slice(5, 7))}`;
};

/**
 * Ranks open tasks of the given kinds by what is most worth doing now, with the reasons in Hebrew.
 * Waiting tasks are excluded (blocked on someone); "someday" stays, but at the bottom. kinds: null = any kind.
 */
export function focusList(tasks, schema, today, { kinds = ['solo'], maxMinutes = null } = {}) {
  const category = (t) => schema.statuses.find((s) => s.id === t.status)?.category || 'todo';
  const waiting = (t) => t.status === 'waiting' || /ממתין|waiting/i.test(schema.statuses.find((s) => s.id === t.status)?.label || '');
  const out = [];
  for (const task of tasks) {
    const kind = kindOfTask(task);
    if ((kinds && (!kind || !kinds.includes(kind.id))) || task.archived || ['done', 'inbox'].includes(category(task)) || waiting(task)) continue;
    const effort = effortOfTask(task);
    // "I have N minutes": what fits; tasks without an estimate stay, but after the ones known to fit.
    if (maxMinutes && effort && effort.minutes > maxMinutes) continue;
    let score = 0; const why = [];
    if (maxMinutes && !effort) score -= 15;
    if (task.deadline) {
      const d = dayDiff(task.deadline, today);
      if (d < 0) { score += 100; why.push(`באיחור ${-d === 1 ? 'יום' : `${-d} ימים`}`); }
      else if (d === 0) { score += 80; why.push('דדליין היום'); }
      else if (d <= 3) { score += 60 - d * 10; why.push(`דדליין ${dayName(task.deadline, today)}`); }
      else if (d <= 7) { score += 20; why.push(`דדליין ${dayName(task.deadline, today)}`); }
    }
    if (task.priority === 'urgent') { score += 40; why.push('דחוף'); } else if (task.priority === 'high') { score += 25; why.push('חשוב'); }
    if (category(task) === 'active') { score += 20; why.push('כבר בעבודה'); }
    if (task.when && task.when <= today) { score += 15; why.push(task.when === today ? 'מתוכנן להיום' : 'נגרר מימים קודמים'); }
    else if (task.when && dayDiff(task.when, today) <= 3) { score += 5; why.push(`מתוכנן ל${dayName(task.when, today)}`); }
    const done = task.steps.filter((s) => s.done).length;
    if (done && done < task.steps.length) { score += 8; why.push(`באמצע (${done}/${task.steps.length})`); }
    const project = schema.projects.find((p) => p.id === task.project);
    if (project?.due && dayDiff(project.due, today) >= 0 && dayDiff(project.due, today) <= 10) { score += 10; why.push(`יעד ${project.name} ${dayName(project.due, today)}`); }
    const later = category(task) === 'later';
    if (later) score -= 40;
    if (effort) why.push(effort.label);
    out.push({ task, kind, effort, score, why, later, nextStep: task.steps.find((s) => !s.done)?.text || null });
  }
  return out.sort((a, b) => b.score - a.score || (a.task.deadline || '9').localeCompare(b.task.deadline || '9') || Number(a.task.id) - Number(b.task.id));
}
