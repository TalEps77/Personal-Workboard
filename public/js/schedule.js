// The schedule (לו״ז) on the dashboard: today's timeline, items in the agenda and on tasks, and a small sheet to
// add / move / delete. Mostly Hermes fills it from WhatsApp; Workboard reminds before each item.
import { api } from './api.js';
import { fail, toast, undoActivity } from './actions.js';
import { openTask } from './components.js';
import { agentName, isDone, setState, spaceInfo, state, gx } from './store.js';
import { DAYS_SHORT, addDays, bdi, dow, h, icon, localTime, niceDate, today } from './util.js';

const KIND = { meeting: { label: 'דיון / פגישה', icon: 'users' }, work: { label: 'זמן עבודה', icon: 'target' }, other: { label: 'אחר', icon: 'calendar' } };
const LEAD = { meeting: 15, work: 10, other: 10 };
export const eventsOn = (date) => state.events.filter((e) => e.date === date).sort((a, b) => a.start.localeCompare(b.start));
export const eventsForTask = (id) => state.events.filter((e) => e.task === id && e.date >= today()).sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`));
const span = (e) => `${e.start}${e.end ? `–${e.end}` : ''}`;
const lead = (e) => (e.remind === -1 ? null : Number.isFinite(e.remind) ? e.remind : LEAD[e.kind] ?? 10);
const dayName = (d) => (d === today() ? 'היום' : d === addDays(today(), 1) ? 'מחר' : `${DAYS_SHORT[dow(d)]} ${Number(d.slice(8))}.${Number(d.slice(5, 7))}`);

/** Which part of life an item belongs to — its colour comes from that, never from the screen you're on. */
export const eventSpaceKind = (e) => spaceInfo(e.space)?.kind || (e.owner === 'home' ? 'home' : 'work');
const SPACE_NAME = { work: 'עבודה', personal: 'אישי', home: 'בית' };

/** One schedule line (agenda, Today, task sheet). */
export function eventItem(e, { showDay = false } = {}) {
  const now = localTime(new Date());
  const past = e.date < today() || (e.date === today() && (e.end || e.start) < now);
  const live = e.date === today() && e.start <= now && now < (e.end || e.start);
  const k = KIND[e.kind] || KIND.other;
  const task = e.task ? state.tasks.get(e.task) : null;
  const sk = eventSpaceKind(e);
  return h('button', { class: ['ev', `ev-${e.kind}`, `ev-sp-${sk}`, past && 'past', live && 'live'], onclick: () => openEvent(e), 'aria-label': `${k.label}${state.multi ? ` (${SPACE_NAME[sk]})` : ''}: ${e.title}, ${dayName(e.date)} ${span(e)}` },
    h('span', { class: 'ev-time num', dir: 'ltr' }, showDay ? h('span', { class: 'ev-day' }, dayName(e.date)) : null, e.start, e.end ? h('span', { class: 'ev-end' }, e.end) : null),
    h('span', { class: 'ev-body' },
      h('span', { class: 'ev-title' }, icon(k.icon, 14), bdi(e.title), live ? h('span', { class: 'ev-now' }, 'עכשיו') : null),
      h('span', { class: 'ev-meta' }, [e.with && `עם ${e.with}`, e.location && `📍 ${e.location}`, task && `#${task.id}${isDone(task) ? ' ✓' : ''}`, lead(e) !== null && !past && !live ? `⏰ ${lead(e)} דק׳ לפני` : null].filter(Boolean).join(' · '))));
}

/** Today's schedule panel: what's left today, with the next item highlighted. */
export function scheduleToday() {
  const items = eventsOn(today());
  const now = localTime(new Date());
  const left = items.filter((e) => (e.end || e.start) >= now);
  return h('section', { class: ['schedule', !items.length && 'is-empty'], 'aria-label': 'הלו״ז היום' },
    h('div', { class: 'schedule-head' }, h('h2', {}, icon('calendar', 16), 'הלו״ז היום', items.length ? h('span', { class: 'count num' }, items.length) : null),
      h('button', { class: 'icon-btn small', 'aria-label': gx`הוסף ללו״ז`, title: gx`הוסף ללו״ז`, onclick: () => openEventForm({ date: today() }) }, icon('plus', 16))),
    items.length
      ? h('div', { class: 'ev-list' }, (left.length ? left : items).map((e) => eventItem(e)), left.length < items.length && left.length ? h('p', { class: 'muted small ev-past-note' }, `${items.length - left.length} כבר עברו`) : null)
      : h('p', { class: 'muted small' }, gx`אין כלום בלו״ז היום. ספר ל־${agentName()} מה קבעת ("קבעתי דיון עם X ב־10:00") — הוא יזכיר לך לפני.`));
}

// ---- Sheets ----
let host = null;
const close = () => { host?.remove(); host = null; };
window.addEventListener('hashchange', close);
function sheet(title, ...content) {
  close();
  const openedAt = Date.now();
  host = h('div', { class: 'as-host', onclick: (e) => { if (e.target === host && Date.now() - openedAt > 450) close(); }, onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } } },
    h('div', { class: 'action-sheet ev-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'as-head' }, h('div', { class: 'as-task' }, bdi(title)), h('button', { class: 'icon-btn small', 'aria-label': gx`סגור`, onclick: close }, icon('x', 16))),
      ...content));
  document.body.append(host);
  host.querySelector('button, input')?.focus();
}

async function remove(e) {
  try {
    const { activity } = await api.removeEvent(e.id);
    setState({ events: state.events.filter((x) => x.id !== e.id) });
    toast(`״${e.title}״ הוסר מהלו״ז`, { iconName: 'calendar', action: activity ? { label: 'ביטול', fn: () => undoActivity(activity) } : null });
  } catch (error) { fail(error); }
}

export function openEvent(e) {
  const k = KIND[e.kind] || KIND.other;
  const task = e.task ? state.tasks.get(e.task) : null;
  sheet(e.title,
    h('div', { class: 'ev-detail' },
      h('div', {}, icon(k.icon, 16), k.label, state.multi ? h('span', { class: `space-chip space-${eventSpaceKind(e)}` }, ` · ${SPACE_NAME[eventSpaceKind(e)]}`) : null),
      h('div', {}, icon('clock', 16), `${dayName(e.date)} · ${span(e)}`),
      e.with ? h('div', {}, icon('users', 16), bdi(e.with)) : null,
      e.location ? h('div', {}, icon('flag', 16), bdi(e.location)) : null,
      h('div', {}, icon('bell', 16), lead(e) === null ? 'בלי תזכורת' : `תזכורת בווטסאפ ${lead(e)} דק׳ לפני${e.reminded_at ? (e.remind_error ? ` — ${e.remind_error}` : ' — נשלחה') : ''}`),
      e.notes ? h('p', { class: 'muted' }, bdi(e.notes)) : null),
    task ? h('button', { class: 'as-open', onclick: () => { close(); openTask(task.id); } }, icon('external', 16), `משימה #${task.id}: `, bdi(task.title)) : null,
    h('div', { class: 'as-chip-row ev-actions' },
      h('button', { class: 'as-item', onclick: () => openEventForm(e) }, icon('calendar', 16), 'עריכה / הזזה'),
      h('button', { class: 'as-item tone-danger', onclick: () => { close(); remove(e); } }, icon('trash', 16), 'הסר מהלו״ז')));
}

/** Add or edit an item. `initial` without an id = new. */
export function openEventForm(initial = {}) {
  const isNew = !initial.id;
  const field = (label, input) => h('label', { class: 'ev-field' }, h('span', {}, label), input);
  const title = h('input', { class: 'input', value: initial.title || '', dir: 'auto', placeholder: 'דיון עם… / זמן עבודה על…', 'aria-label': 'כותרת' });
  const date = h('input', { type: 'date', class: 'date-input', value: initial.date || today(), 'aria-label': 'תאריך' });
  const start = h('input', { type: 'time', class: 'date-input', value: initial.start || '', 'aria-label': 'התחלה' });
  const end = h('input', { type: 'time', class: 'date-input', value: initial.end || '', 'aria-label': 'סיום' });
  const kind = h('select', { class: 'select', 'aria-label': 'סוג' }, Object.entries(KIND).map(([v, k]) => h('option', { value: v, selected: v === (initial.kind || 'meeting') }, k.label)));
  const withInput = h('input', { class: 'input', value: initial.with || '', dir: 'auto', placeholder: 'עם מי', 'aria-label': 'עם מי' });
  const leadSel = h('select', { class: 'select', 'aria-label': 'תזכורת' }, [['', 'ברירת מחדל'], ['5', '5 דק׳ לפני'], ['10', '10 דק׳ לפני'], ['15', 'רבע שעה לפני'], ['30', 'חצי שעה לפני'], ['60', 'שעה לפני'], ['-1', 'בלי תזכורת']].map(([v, l]) => h('option', { value: v, selected: String(initial.remind ?? '') === v }, l)));
  const open = [...state.tasks.values()].filter((t) => !isDone(t) && !t.archived).sort((a, b) => a.title.localeCompare(b.title, 'he'));
  const taskSel = h('select', { class: 'select', 'aria-label': 'משימה' }, h('option', { value: '' }, 'ללא משימה'), open.map((t) => h('option', { value: t.id, selected: t.id === initial.task }, `#${t.id} ${t.title}`)));
  // Work, personal or home: decides the item's colour (and, for home, that both of you get the reminder).
  const spaceSel = state.multi ? h('select', { class: 'select', 'aria-label': 'מרחב' }, state.spaces.map((x) => h('option', { value: x.id, selected: x.id === (initial.space || (initial.owner === 'home' ? state.spaces.find((y) => y.kind === 'home')?.id : state.spaces.find((y) => y.kind === 'work' && y.owner === state.me?.id)?.id)) }, x.label))) : null;
  const msg = h('p', { class: 'danger small', role: 'alert' });
  const save = async () => {
    const body = { title: title.value.trim() || (taskSel.value ? state.tasks.get(taskSel.value)?.title : ''), date: date.value, start: start.value, end: end.value || null, kind: kind.value, with: withInput.value.trim(), remind: leadSel.value === '' ? null : Number(leadSel.value), task: taskSel.value || null, ...(spaceSel && { space: spaceSel.value, owner: spaceInfo(spaceSel.value)?.kind === 'home' ? 'home' : state.me?.id }) };
    try {
      const saved = isNew ? await api.addEvent(body) : await api.updateEvent(initial.id, body);
      setState({ events: [...state.events.filter((x) => x.id !== saved.id), saved] });
      close();
      toast(`${isNew ? 'נוסף ללו״ז' : 'עודכן'}: ${saved.title} · ${dayName(saved.date)} ${span(saved)}`, { iconName: 'calendar' });
    } catch (error) { msg.textContent = error.message; }
  };
  sheet(isNew ? 'הוספה ללו״ז' : 'עריכת פריט בלו״ז',
    h('div', { class: 'ev-form' },
      field('מה', title),
      h('div', { class: 'ev-row' }, field('תאריך', date), field('התחלה', start), field('סיום', end)),
      h('div', { class: 'ev-row' }, field('סוג', kind), spaceSel ? field('מרחב', spaceSel) : null, field('תזכורת', leadSel)),
      field('עם מי', withInput),
      field('משימה קשורה', taskSel),
      msg,
      h('button', { class: 'btn primary', onclick: save }, isNew ? gx`הוסף ללו״ז` : gx`שמור`)));
}
