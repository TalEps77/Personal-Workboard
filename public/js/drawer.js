import { api } from './api.js';
import { archiveTask, createTask, deleteTask, fail, toast, undoActivity, updateTask } from './actions.js';
import { progressBar, spaceChip } from './components.js';
import { actorInfo, fieldsFor, isDone, kindOfSpace, orderedStatuses, personName, putTask, spaceOf, state, statusOf, gx, agentName } from './store.js';
import { DAYS, addDays, bdi, debounce, dow, h, icon, localDate, localTime, niceDate, niceDateTime, relative, today, zonedIso } from './util.js';
import { rubberband, spring } from './motion.js';
import { EFFORTS, effortOfTask } from './focus.js';
import { eventItem, eventsForTask, openEventForm } from './schedule.js';

const REPEATS = [['', 'פעם אחת'], ['daily', 'כל יום'], ['weekdays', 'ימי עבודה (א׳–ה׳)'], ['weekly', 'כל שבוע'], ['monthly', 'כל חודש']];
const NAGS = [['', 'בלי נדנוד'], ['15', 'כל 15 דק׳ עד שבוצע'], ['30', 'כל 30 דק׳ עד שבוצע'], ['60', 'כל שעה עד שבוצע'], ['180', 'כל 3 שעות עד שבוצע']];

let taskActivity = { id: null, items: [] };
// Side effects must not run on every render: each task is marked seen at most once per page load.
const markedSeen = new Set();
// Unsaved reminder-form input per task, kept outside the DOM so live re-renders don't wipe it.
const reminderDrafts = new Map();
async function loadActivity(id) {
  try { taskActivity = { id, items: (await api.activity(id, 15)).items }; } catch { taskActivity = { id, items: [] }; }
}
export function refreshDrawerActivity() { if (state.openTask) loadActivity(state.openTask).then(() => document.dispatchEvent(new Event('wb:rerender'))); }

function autosize(el) {
  const fit = () => { el.style.blockSize = 'auto'; el.style.blockSize = `${el.scrollHeight + 2}px`; };
  el.addEventListener('input', fit);
  requestAnimationFrame(fit);
  return el;
}

function prop(label, iconName, control) {
  return h('div', { class: 'prop' }, h('span', { class: 'prop-label' }, icon(iconName, 15), label), h('div', { class: 'prop-value' }, control));
}

function select(options, value, onchange, key, label) {
  return h('select', { class: 'select', dataset: { key }, 'aria-label': label || null, onchange: (e) => onchange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: v === (value ?? '') }, label)));
}

function dateControl(task, field, key) {
  const t = today();
  const input = h('input', { type: 'date', class: 'date-input', value: task[field] || '', dataset: { key }, 'aria-label': field === 'deadline' ? 'דדליין' : 'תאריך עבודה', onchange: (e) => updateTask(task.id, { [field]: e.target.value || null }) });
  const quick = (label, value) => h('button', { class: ['mini', task[field] === value && 'on'], onclick: () => updateTask(task.id, { [field]: value }) }, label);
  return h('div', { class: 'date-control' }, input,
    task[field] && ![t, addDays(t, 1), addDays(t, (7 - dow(t)) % 7 || 7)].includes(task[field]) ? h('span', { class: 'muted small' }, niceDate(task[field])) : null,
    h('div', { class: 'mini-group' }, quick('היום', t), quick('מחר', addDays(t, 1)), addDays(t, (7 - dow(t)) % 7 || 7) !== addDays(t, 1) ? quick(`יום ${DAYS[0]}`, addDays(t, (7 - dow(t)) % 7 || 7)) : null,
      task[field] ? h('button', { class: 'mini ghost', title: 'נקה', onclick: () => updateTask(task.id, { [field]: null }) }, icon('x', 12)) : null));
}

function tagsControl(task) {
  const input = h('input', { class: 'tag-input', placeholder: task.tags.length ? '' : gx`הוסף תגית…`, dir: 'auto', dataset: { key: `tags-${task.id}` }, list: 'wb-tags' });
  input.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
      e.preventDefault();
      const tag = input.value.trim().replace(/^#/, '');
      if (!task.tags.includes(tag)) updateTask(task.id, { tags: [...task.tags, tag] });
      input.value = '';
    }
    if (e.key === 'Backspace' && !input.value && task.tags.length) updateTask(task.id, { tags: task.tags.slice(0, -1) });
  });
  const known = [...new Set([...state.schema.tags, ...[...state.tasks.values()].flatMap((t) => t.tags)])];
  return h('div', { class: 'tags-control' },
    task.tags.map((tag) => h('span', { class: 'tag removable' }, `#${tag}`, h('button', { 'aria-label': `הסר ${tag}`, onclick: () => updateTask(task.id, { tags: task.tags.filter((x) => x !== tag) }) }, icon('x', 11)))),
    input, h('datalist', { id: 'wb-tags' }, known.map((t) => h('option', { value: t }))));
}

function fieldControl(task, f) {
  const value = task.fields[f.id];
  const key = `field-${task.id}-${f.id}`;
  const save = (v) => updateTask(task.id, { fields: { [f.id]: v === '' ? null : v } });
  if (f.type === 'select') return select([['', '—'], ...f.options.map((o) => [o, o])], value, save, key);
  if (f.type === 'checkbox') return h('input', { type: 'checkbox', class: 'checkbox', checked: Boolean(value), dataset: { key }, onchange: (e) => save(e.target.checked) });
  const type = { number: 'number', date: 'date', url: 'url', duration: 'text', text: 'text' }[f.type];
  const input = h('input', { type, class: 'input', value: value ?? '', dir: 'auto', placeholder: f.type === 'duration' ? 'למשל 30 דק׳' : f.placeholder || '', dataset: { key }, onchange: (e) => save(f.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value) });
  if (f.type === 'url' && value && /^https?:\/\//i.test(value)) return h('div', { class: 'url-field' }, input, h('a', { href: value, target: '_blank', rel: 'noopener noreferrer', class: 'icon-btn small', title: gx`פתח` }, icon('external', 14)));
  return input;
}

// Reorder steps by dragging the grip — Pointer Events, so it works with a finger as well as a mouse (HTML5
// drag-and-drop never fires on iOS). The lifted step tracks the finger 1:1 and rubber-bands past the ends; the
// others slide aside to show where it will land; on release it springs into its slot, then the order is saved.
function enableStepReorder(list, steps, save) {
  list.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.grip');
    if (!grip || e.button > 0) return;
    e.preventDefault();
    const li = grip.closest('.step');
    const items = [...list.children];
    const from = items.indexOf(li);
    const rects = items.map((x) => x.getBoundingClientRect());
    const minDy = rects[0].top - rects[from].top;
    const maxDy = rects[rects.length - 1].bottom - rects[from].bottom;
    const startY = e.clientY;
    let to = from; let shown = 0;
    grip.setPointerCapture(e.pointerId);
    list.classList.add('reordering');
    li.classList.add('lifted');
    const paint = (y) => { shown = y; li.style.transform = `translate3d(0,${y}px,0)`; };
    const move = (ev) => {
      const dy = ev.clientY - startY;
      paint(dy < minDy ? minDy + rubberband(dy - minDy, rects[from].height * 2) : dy > maxDy ? maxDy + rubberband(dy - maxDy, rects[from].height * 2) : dy);
      const centre = rects[from].top + rects[from].height / 2 + shown;
      to = rects.reduce((n, r, i) => n + (i !== from && r.top + r.height / 2 < centre ? 1 : 0), 0);
      const gap = rects[from].height;
      items.forEach((x, i) => {
        if (x === li) return;
        const shift = from < to && i > from && i <= to ? -gap : from > to && i < from && i >= to ? gap : 0;
        x.style.transform = shift ? `translate3d(0,${shift}px,0)` : '';
      });
    };
    const finish = (ev) => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', finish);
      grip.removeEventListener('pointercancel', finish);
      if (ev.type === 'pointercancel') to = from;
      const slot = to > from ? rects[to].bottom - rects[from].bottom : rects[to].top - rects[from].top;
      const reset = () => { list.classList.remove('reordering'); li.classList.remove('lifted'); items.forEach((x) => { x.style.transform = ''; }); };
      if (to === from) items.forEach((x) => { if (x !== li) x.style.transform = ''; });
      spring({ from: shown, to: to === from ? 0 : slot, damping: 1, response: 0.28, onUpdate: paint, onDone: () => {
        if (to === from || !li.isConnected) { reset(); return; }
        const next = [...steps];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        save(next); // the re-render rebuilds the list in its new order
      } });
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
  });
}

// ---- Steps: the checklist inside a task ----
function stepsBlock(task) {
  const save = (steps) => updateTask(task.id, { steps });
  const list = h('ol', { class: 'steps' });
  task.steps.forEach((step, i) => {
    const text = h('input', { class: 'step-text', value: step.text, dir: 'auto', dataset: { key: `step-${task.id}-${i}` }, 'aria-label': `שלב ${i + 1}` });
    text.addEventListener('change', () => {
      const v = text.value.trim();
      save(v ? task.steps.map((s, j) => (j === i ? { ...s, text: v } : s)) : task.steps.filter((_, j) => j !== i));
    });
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); text.blur(); document.querySelector(`[data-key="new-step-${task.id}"]`)?.focus(); }
      if (e.key === 'Backspace' && !text.value) { e.preventDefault(); save(task.steps.filter((_, j) => j !== i)); }
    });
    const item = h('li', { class: ['step', step.done && 'done'], dataset: { index: i } },
      h('span', { class: 'grip', title: gx`גרור לשינוי סדר`, 'aria-hidden': 'true' }, icon('grip', 14)),
      h('label', { class: 'step-check' }, h('input', { type: 'checkbox', checked: step.done, 'aria-label': `שלב ${i + 1}: ${step.text}`, onchange: (e) => save(task.steps.map((s, j) => (j === i ? { ...s, done: e.target.checked } : s))) }), h('span', { class: 'box' }, icon('check', 12))),
      text,
      h('div', { class: 'step-actions' },
        h('button', { class: 'icon-btn small', title: 'הפוך למשימה נפרדת', onclick: async () => { const created = await createTask({ title: step.text, project: task.project, tags: task.tags }); if (created) { save(task.steps.filter((_, j) => j !== i)); toast(`נוצרה משימה #${created.id}`, { iconName: 'external' }); } } }, icon('external', 13)),
        h('button', { class: 'icon-btn small', title: gx`מחק שלב`, onclick: () => save(task.steps.filter((_, j) => j !== i)) }, icon('x', 13))));
    list.append(item);
  });
  enableStepReorder(list, task.steps, save);

  const adder = h('input', { class: 'step-add', placeholder: task.steps.length ? 'שלב נוסף… (Enter)' : gx`פרק את המשימה לשלבים — הקלד שלב ולחץ Enter`, dir: 'auto', dataset: { key: `new-step-${task.id}` } });
  adder.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || !adder.value.trim()) return;
    // Pasting several lines adds several steps.
    const added = adder.value.split(/\n|;/).map((s) => s.trim()).filter(Boolean).map((t) => ({ text: t, done: false }));
    adder.value = '';
    save([...task.steps, ...added]);
  });
  adder.addEventListener('paste', (e) => {
    const text = e.clipboardData.getData('text');
    if (!text.includes('\n')) return;
    e.preventDefault();
    const added = text.split('\n').map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])?\s*(?:\[[ xX]\]\s*)?/, '').trim()).filter(Boolean).map((t) => ({ text: t, done: false }));
    save([...task.steps, ...added]);
  });
  const p = { done: task.steps.filter((s) => s.done).length, total: task.steps.length };
  return h('section', { class: 'block' },
    h('div', { class: 'block-head' }, h('h3', {}, icon('checkCircle', 16), 'שלבים'), progressBar(task),
      p.total && p.done === p.total && !isDone(task) ? h('button', { class: 'btn small success', onclick: () => updateTask(task.id, { status: state.schema.statuses.find((s) => s.category === 'done').id }) }, icon('check', 14), gx`כל השלבים בוצעו — סגור משימה`) : null),
    list, h('div', { class: 'step-new' }, icon('plus', 15), adder));
}

// ---- Reminders ----
function remindersBlock(task) {
  const t = today();
  const now = new Date();
  const inMinutes = (m) => new Date(Date.now() + m * 60000).toISOString();
  const at = (date, time) => zonedIso(date, time);
  const hour = Number(localTime(now).slice(0, 2));
  const presets = [
    ['בעוד שעה', inMinutes(60)],
    ['בעוד 3 שעות', inMinutes(180)],
    hour < 17 ? ['היום ב־17:00', at(t, '17:00')] : null,
    ['מחר ב־09:00', at(addDays(t, 1), '09:00')],
    [`יום ${DAYS[0]} ב־09:00`, at(addDays(t, (7 - dow(t)) % 7 || 7), '09:00')],
    task.deadline && task.deadline > t ? ['יום לפני הדדליין', at(addDays(task.deadline, -1), '09:00')] : null,
  ].filter(Boolean);
  if (!reminderDrafts.has(task.id)) reminderDrafts.set(task.id, { note: '', date: t, time: '09:00', repeat: '', nag: '' });
  const draft = reminderDrafts.get(task.id);
  const keep = (key) => (e) => { draft[key] = e.target.value; };
  const note = h('input', { class: 'input', placeholder: 'הערה לתזכורת (לא חובה)', dir: 'auto', dataset: { key: `rem-note-${task.id}` }, value: draft.note, oninput: keep('note') });
  const date = h('input', { type: 'date', class: 'date-input', value: draft.date, 'aria-label': 'תאריך התזכורת', dataset: { key: `rem-date-${task.id}` }, onchange: keep('date') });
  const time = h('input', { type: 'time', class: 'date-input', value: draft.time, 'aria-label': 'שעת התזכורת', dataset: { key: `rem-time-${task.id}` }, onchange: keep('time') });
  // Repeat and nag are mutually exclusive (a nag already repeats until the task is done).
  const repeat = select(REPEATS, draft.repeat, (v) => { draft.repeat = v; if (v) draft.nag = ''; document.dispatchEvent(new Event('wb:rerender')); }, `rem-repeat-${task.id}`, 'חזרה');
  const nag = select(NAGS, draft.nag, (v) => { draft.nag = v; if (v) draft.repeat = ''; document.dispatchEvent(new Event('wb:rerender')); }, `rem-nag-${task.id}`, 'הצקה עד שמסמנים בוצע');
  const add = async (iso) => {
    if (Date.parse(iso) < Date.now() - 60_000) { fail(new Error('הזמן שבחרת כבר עבר')); return; }
    try {
      const saved = await api.addReminder(task.id, { at: iso, note: draft.note.trim(), repeat: draft.repeat || null, nag: draft.nag ? Number(draft.nag) : null });
      putTask(saved);
      reminderDrafts.delete(task.id);
      toast(`תזכורת נקבעה ל${niceDateTime(iso)}`, { iconName: 'bell', tone: 'success' });
    } catch (error) { fail(error); }
  };
  const active = task.reminders.filter((r) => !r.done).sort((a, b) => a.at.localeCompare(b.at));
  const past = task.reminders.filter((r) => r.done).slice(-3);
  const reminderItem = (r) => h('li', { class: ['reminder', r.done && 'sent', r.last_error && 'failed'] },
    icon(r.nag ? 'repeat' : r.repeat ? 'repeat' : 'bell', 15),
    h('div', { class: 'reminder-body' },
      h('div', { class: 'reminder-when' }, h('strong', {}, niceDateTime(r.at)), r.done ? h('span', { class: 'muted small' }, ` · נשלחה ${r.last_sent_at ? relative(r.last_sent_at) : ''}`) : h('span', { class: 'muted small' }, ` · ${relative(r.at)}`)),
      r.note ? h('div', { class: 'small' }, bdi(r.note)) : null,
      r.repeat || r.nag ? h('div', { class: 'muted small' }, [r.repeat && REPEATS.find(([v]) => v === r.repeat)?.[1], r.nag && `נדנוד כל ${r.nag} דק׳`].filter(Boolean).join(' · ')) : null,
      r.last_error ? h('div', { class: 'danger small' }, `השליחה נכשלה: ${r.last_error}`) : null),
    !r.done ? h('div', { class: 'reminder-actions' },
      h('button', { class: 'mini', title: gx`דחה בשעה`, onclick: async () => { try { putTask(await api.snooze(task.id, r.id, { minutes: 60 })); toast('נדחה בשעה', { iconName: 'clock' }); } catch (e) { fail(e); } } }, '+1ש׳'),
      h('button', { class: 'mini', title: gx`דחה למחר 09:00`, onclick: async () => { try { putTask(await api.snooze(task.id, r.id, { at: at(addDays(t, 1), '09:00') })); toast('נדחה למחר ב־9:00', { iconName: 'clock' }); } catch (e) { fail(e); } } }, 'מחר'),
      h('button', { class: 'icon-btn small', title: gx`מחק תזכורת`, onclick: async () => { try { putTask(await api.removeReminder(task.id, r.id)); } catch (e) { fail(e); } } }, icon('trash', 13))) : null);

  return h('section', { class: 'block' },
    h('div', { class: 'block-head' }, h('h3', {}, icon('bell', 16), 'תזכורות'),
      !state.notifier.configured ? h('span', { class: 'pill c-amber', title: `החיבור ל־${agentName()} לא הוגדר — תזכורות לא יישלחו` }, '⚠ WhatsApp לא מחובר') : h('span', { class: 'muted small' }, 'יישלחו אליך ב־WhatsApp')),
    active.length || past.length ? h('ul', { class: 'reminders' }, active.map(reminderItem), past.map(reminderItem)) : null,
    h('details', { class: 'reminder-add', open: !active.length, dataset: { key: `rem-details-${task.id}` } },
      h('summary', {}, icon('plus', 14), 'תזכורת חדשה'),
      h('div', { class: 'preset-row' }, presets.map(([label, iso]) => h('button', { class: 'chip-btn', onclick: () => add(iso) }, label))),
      h('div', { class: 'custom-row' }, date, time, h('button', { class: 'btn small primary', onclick: () => { if (!draft.date) { fail(new Error(gx`בחר תאריך`)); return; } add(at(draft.date, draft.time || '09:00')); } }, gx`קבע`)),
      h('div', { class: 'custom-row' }, repeat, nag),
      note));
}

function activityBlock(task) {
  if (taskActivity.id !== task.id) { taskActivity = { id: task.id, items: [] }; loadActivity(task.id).then(() => document.dispatchEvent(new Event('wb:rerender'))); }
  const items = taskActivity.id === task.id ? taskActivity.items : [];
  return h('section', { class: 'block' },
    h('div', { class: 'block-head' }, h('h3', {}, icon('zap', 16), 'היסטוריה')),
    items.length ? h('ol', { class: 'feed compact' }, items.map((a) => h('li', { class: ['feed-item', actorInfo(a.actor).agent && 'by-agent'] },
      h('span', { class: 'feed-icon' }, icon(actorInfo(a.actor).icon, 13)),
      h('div', { class: 'feed-body' }, h('div', {}, h('strong', {}, actorInfo(a.actor).name), ' · ', a.summary), h('div', { class: 'feed-meta' }, relative(a.at))),
      a.undoable ? h('button', { class: 'icon-btn small', title: gx`בטל שינוי זה`, onclick: async () => { await undoActivity(a); loadActivity(task.id).then(() => document.dispatchEvent(new Event('wb:rerender'))); } }, icon('undo', 13)) : null)))
      : h('p', { class: 'muted small' }, '—'));
}

// One line that says where the task stands; tap to edit the details (HIG: sheets: progressive disclosure).
function propsSummary(task) {
  const s = statusOf(task.status);
  const pr = state.schema.projects.find((p) => p.id === task.project);
  const pri = state.schema.priorities.find((p) => p.id === task.priority);
  const dates = task.when && task.deadline && task.when !== task.deadline ? `${niceDate(task.when)} ← ${niceDate(task.deadline)}` : task.deadline ? `דדליין ${niceDate(task.deadline)}` : task.when ? niceDate(task.when) : 'ללא תאריך';
  return h('span', { class: 'props-line' },
    spaceChip(task, { always: true }),
    h('span', { class: `pill c-${s.color}` }, h('span', { class: 'dot' }), s.label),
    pr ? h('span', { class: `meta-item c-${pr.color}` }, h('span', { class: 'dot' }), bdi(pr.name)) : h('span', { class: 'meta-item' }, 'ללא פרויקט'),
    h('span', { class: ['meta-item', task.deadline && task.deadline < today() && !isDone(task) && 'is-danger'] }, icon('calendar', 13), dates),
    pri && pri.rank <= 1 ? h('span', { class: `meta-item c-${pri.color}`, style: { color: 'var(--c)' } }, icon('flag', 13), pri.label) : null);
}

// The sheet as a work surface: one primary action (start → done), the next step to tick, and a rough effort.
function workBar(task) {
  if (isDone(task) || task.archived) return null;
  const s = statusOf(task.status);
  const waiting = s.id === 'waiting' || /ממתין/.test(s.label);
  const working = s.category === 'active' && !waiting;
  const doing = state.schema.statuses.find((x) => x.category === 'active' && x.id !== 'waiting' && !/ממתין/.test(x.label));
  const doneId = state.schema.statuses.find((x) => x.category === 'done')?.id;
  const nextIndex = task.steps.findIndex((x) => !x.done);
  const primary = working
    ? h('button', { class: 'btn work-btn done', onclick: () => updateTask(task.id, { status: doneId }) }, icon('check', 18), 'סיימתי')
    : doing ? h('button', { class: 'btn primary work-btn', onclick: () => updateTask(task.id, { status: doing.id }) }, icon('zap', 18), gx`התחל לעבוד`) : null;
  const step = nextIndex >= 0 ? h('button', { class: 'next-step', title: gx`סמן את השלב כבוצע`, onclick: () => updateTask(task.id, { steps: task.steps.map((x, j) => (j === nextIndex ? { ...x, done: true } : x)) }) },
    h('span', { class: 'next-step-box' }, icon('check', 12)), h('span', { class: 'next-step-text' }, h('span', { class: 'muted small' }, `שלב ${nextIndex + 1}/${task.steps.length} · `), bdi(task.steps[nextIndex].text))) : null;
  const hasEffort = state.schema.fields.some((f) => f.id === 'effort');
  const current = effortOfTask(task);
  const effort = hasEffort ? h('div', { class: 'effort-chips', role: 'group', 'aria-label': 'משך משוער' }, h('span', { class: 'muted small' }, 'משך:'),
    EFFORTS.map((e) => h('button', { class: ['mini', current?.label === e.label && 'on'], 'aria-pressed': String(current?.label === e.label), onclick: () => updateTask(task.id, { fields: { effort: current?.label === e.label ? null : e.label } }) }, e.label))) : null;
  const booked = eventsForTask(task.id);
  const plan = h('div', { class: 'work-schedule' }, booked.map((e) => eventItem(e, { showDay: true })),
    h('button', { class: 'link-btn', onclick: () => openEventForm({ task: task.id, title: task.title, kind: 'work', date: today() }) }, icon('calendar', 14), booked.length ? 'עוד זמן בלו״ז' : 'לשבץ זמן בלו״ז'));
  return h('div', { class: 'work-bar' }, h('div', { class: 'work-row' }, primary, waiting ? h('span', { class: 'muted small' }, `ממתין${task.fields?.with ? ` ל${task.fields.with}` : ''}`) : null), step, plan, effort);
}

export function drawer(task) {
  if (!task) return null;
  if (!task.seen && !markedSeen.has(task.id)) { markedSeen.add(task.id); updateTask(task.id, { seen: true }, { quiet: true }); }
  // Leave the way it came (the app animates the sheet out, then navigates).
  const close = () => document.dispatchEvent(new Event('wb:close-sheet'));
  const title = autosize(h('textarea', { class: 'drawer-title', rows: 1, dir: 'auto', dataset: { key: `title-${task.id}` }, 'aria-label': 'כותרת המשימה' }, task.title));
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  title.addEventListener('change', () => { const v = title.value.trim(); if (v && v !== task.title) updateTask(task.id, { title: v }); else title.value = task.title; });
  const notes = autosize(h('textarea', { class: 'notes', dir: 'auto', placeholder: 'הקשר, קישורים, החלטות…', dataset: { key: `notes-${task.id}` } }, task.notes));
  const saveNotes = debounce(() => { if (notes.value !== state.tasks.get(task.id)?.notes) updateTask(task.id, { notes: notes.value }); }, 2000);
  notes.addEventListener('input', saveNotes);
  notes.addEventListener('blur', () => { if (notes.value !== state.tasks.get(task.id)?.notes) updateTask(task.id, { notes: notes.value }); });

  const s = statusOf(task.status);
  const statusSelect = h('div', { class: 'status-chips' }, orderedStatuses().map((st) => h('button', { class: ['status-chip', `c-${st.color}`, st.id === task.status && 'on'], onclick: () => st.id !== task.status && updateTask(task.id, { status: st.id }) }, h('span', { class: 'dot' }), st.label)));
  const prioritySelect = h('div', { class: 'mini-group' }, state.schema.priorities.map((p) => h('button', { class: ['mini', `c-${p.color}`, p.id === task.priority && 'on'], onclick: () => updateTask(task.id, { priority: p.id }) }, p.label)));
  // Only the projects of the task's own space (a home task can't sit in a work project).
  const sameSpace = (p) => !state.multi || (p.space || 'work') === spaceOf(task) || p.id === task.project;
  const projectSelect = select([['', 'ללא פרויקט'], ...state.schema.projects.filter((p) => (!p.archived || p.id === task.project) && sameSpace(p)).map((p) => [p.id, p.name])], task.project, (v) => updateTask(task.id, { project: v || null }), `project-${task.id}`);
  const SPACE_ICON = { work: 'briefcase', personal: 'user', home: 'home' };
  // Moving to another space drops a project that belongs to the old one.
  const spaceSelect = state.multi ? h('div', { class: 'mini-group' }, state.spaces.map((x) => h('button', { class: ['mini', x.id === spaceOf(task) && 'on'], 'aria-pressed': String(x.id === spaceOf(task)), onclick: () => { if (x.id === spaceOf(task)) return; const pr = state.schema.projects.find((p) => p.id === task.project); updateTask(task.id, { space: x.id, ...(pr && (pr.space || 'work') !== x.id && { project: null }), ...(x.kind === 'home' ? { assignee: task.assignee || state.me?.id || null } : { assignee: null }) }); } }, icon(SPACE_ICON[x.kind], 13), x.label))) : null;
  const others = state.people.filter((x) => x.id !== state.me?.id);
  const assigneeSelect = state.multi && kindOfSpace(task) === 'home' ? h('div', { class: 'mini-group' }, [[state.me?.id, 'עליי'], ...others.map((x) => [x.id, x.name]), ['both', 'שנינו'], [null, 'לא נקבע']].map(([v, label]) => h('button', { class: ['mini', (task.assignee || null) === v && 'on'], 'aria-pressed': String((task.assignee || null) === v), onclick: () => updateTask(task.id, { assignee: v }) }, label))) : null;

  return h('aside', { class: `drawer c-${s.color}` },
    h('header', { class: 'drawer-head' },
      h('span', { class: 'grabber', 'aria-hidden': 'true' }),
      h('span', { class: 'row-id num' }, `#${task.id}`),
      task.source === 'whatsapp' ? h('span', { class: 'pill c-green', title: 'נוצרה דרך WhatsApp' }, icon('chat', 12), 'WhatsApp') : null,
      h('span', { class: 'muted small' }, `נוצרה ${relative(task.created_at)}`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn', title: task.archived ? gx`החזר מהארכיון` : gx`העבר לארכיון`, onclick: () => archiveTask(task) }, icon('archive', 16)),
      h('button', { class: 'icon-btn', title: gx`מחק`, onclick: () => { if (confirm(`למחוק את ״${task.title}״? (אפשר לשחזר מההיסטוריה)`)) { deleteTask(task); close(); } } }, icon('trash', 16)),
      h('button', { class: 'icon-btn', title: gx`סגור (Esc)`, onclick: close }, icon('x', 18))),
    h('div', { class: 'drawer-scroll' },
      h('div', { class: 'title-row' },
        h('button', { class: ['check', 'big', isDone(task) && 'is-done'], title: isDone(task) ? gx`החזר לפתוחות` : gx`סמן כבוצע`, onclick: () => updateTask(task.id, { status: isDone(task) ? state.schema.statuses.find((x) => x.category === 'todo')?.id || state.schema.statuses[0].id : state.schema.statuses.find((x) => x.category === 'done').id }) }, icon('check', 16)),
        title),
      workBar(task),
      task.archived ? h('div', { class: 'banner' }, icon('archive', 14), 'המשימה בארכיון') : null,
      h('details', { class: 'props-wrap', open: !matchMedia('(max-width: 820px)').matches, dataset: { key: `props-${task.id}` } },
        h('summary', { class: 'props-summary' }, propsSummary(task), h('span', { class: 'props-edit' }, 'עריכה')),
      h('div', { class: 'props' },
        spaceSelect ? prop('מרחב', 'home', spaceSelect) : null,
        assigneeSelect ? prop('על מי', 'users', assigneeSelect) : null,
        prop('סטטוס', 'layers', statusSelect),
        prop('עדיפות', 'flag', prioritySelect),
        prop('פרויקט', 'folder', projectSelect),
        prop('מתוכנן ל', 'calendar', dateControl(task, 'when', `when-${task.id}`)),
        prop('דדליין', 'flag', dateControl(task, 'deadline', `deadline-${task.id}`)),
        prop('תגיות', 'tag', tagsControl(task)),
        fieldsFor(task).filter((f) => f.id !== 'effort').map((f) => prop(f.label, f.id === 'kind' ? 'user' : f.id === 'with' ? 'users' : 'sparkles', fieldControl(task, f))))),
      stepsBlock(task),
      h('section', { class: 'block' }, h('div', { class: 'block-head' }, h('h3', {}, icon('note', 16), 'הערות')), notes),
      remindersBlock(task),
      activityBlock(task),
      h('p', { class: 'muted small file-hint' }, `נשמר כ־data/tasks/${task.id}.md · עודכן ${task.updated_at ? relative(task.updated_at) : ''}${task.completed_at ? ` · הושלם ${localDate(task.completed_at) === today() ? 'היום' : niceDate(localDate(task.completed_at))}` : ''}`)));
}
