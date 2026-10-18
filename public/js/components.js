import { createTask, setStatus, toast, toggleDone, updateTask } from './actions.js';
import { KINDS, kindOfTask } from './focus.js';
import { categoryOf, currentSpace, fieldsFor, isDone, isFresh, kindOfSpace, nextReminder, orderedStatuses, personName, priorityOf, progress, projectOf, setState, spaceInfo, spaceOf, state, statusOf, gx } from './store.js';
import { DAYS, DAYS_SHORT, addDays, bdi, dow, h, icon, localDate, localTime, niceDate, today, nextWeekStart, nextWorkday } from './util.js';
import { project, rubberband, spring, velocityTracker } from './motion.js';

export const openTask = (id) => { location.hash = `#/task/${id}`; };

export function statusPill(task) {
  const s = statusOf(task.status);
  return h('span', { class: `pill c-${s.color}` }, h('span', { class: 'dot' }), s.label);
}

export function progressBar(task, { compact = false } = {}) {
  const p = progress(task);
  if (!p.total) return null;
  const pct = Math.round((p.done / p.total) * 100);
  return h('span', { class: ['progress', compact && 'compact', p.done === p.total && 'complete'], title: `${p.done} מתוך ${p.total} שלבים` },
    h('span', { class: 'progress-track' }, h('span', { class: 'progress-fill', style: { inlineSize: `${pct}%` } })),
    h('span', { class: 'progress-label num' }, `${p.done}/${p.total}`));
}

export function dateChip(task) {
  const out = [];
  const t = today();
  if (task.deadline) {
    const overdue = task.deadline < t && !isDone(task);
    out.push(h('span', { class: ['chip', overdue ? 'chip-danger' : task.deadline === t ? 'chip-warn' : ''], title: 'דדליין' }, icon('flag', 13), `עד ${niceDate(task.deadline)}`));
  }
  if (task.when && task.when !== task.deadline) {
    out.push(h('span', { class: ['chip', task.when <= t && !isDone(task) ? 'chip-accent' : ''], title: 'מתוכנן ל' }, icon('calendar', 13), niceDate(task.when)));
  }
  return out;
}

export function reminderChip(task) {
  const r = nextReminder(task);
  if (!r) return null;
  const failed = Boolean(r.last_error);
  const isToday = localDate(r.at) === today();
  return h('span', { class: ['chip', failed ? 'chip-danger' : 'chip-soft'], title: failed ? `שליחה נכשלה: ${r.last_error}` : `תזכורת${r.note ? `: ${r.note}` : ''}` },
    icon(r.nag ? 'repeat' : 'bell', 13), h('span', { class: 'num', dir: 'ltr' }, isToday ? localTime(r.at) : `${localTime(r.at)}`), isToday ? '' : ` ${niceDate(localDate(r.at))}`);
}

export function projectChip(task) {
  const p = projectOf(task.project);
  return p ? h('span', { class: `chip chip-project c-${p.color}` }, h('span', { class: 'dot' }), bdi(p.name)) : null;
}

function fieldChips(task) {
  return fieldsFor(task).filter((f) => f.id !== 'kind' && f.showOnCard && task.fields[f.id] !== undefined && task.fields[f.id] !== '').map((f) => {
    const v = task.fields[f.id];
    const text = f.type === 'checkbox' ? (v ? '✓' : '✗') : f.type === 'date' ? niceDate(v) : String(v);
    return h('span', { class: 'chip chip-soft', title: f.label }, h('span', { class: 'chip-key' }, `${f.label}:`), bdi(text));
  });
}

function checkButton(task) {
  const p = priorityOf(task.priority);
  return h('button', {
    class: ['check', `prio-${p.color}`, isDone(task) && 'is-done'],
    'aria-label': isDone(task) ? gx`סמן "${task.title}" כלא בוצע` : gx`סמן "${task.title}" כבוצע`,
    title: isDone(task) ? gx`החזר לפתוחות` : gx`סמן כבוצע`,
    onclick: (e) => { e.stopPropagation(); e.currentTarget.classList.add('pop'); toggleDone(task); },
  }, icon('check', 13));
}

function triageButtons(task) {
  const first = (cat) => state.schema.statuses.find((s) => s.category === cat);
  const btn = (label, title, changes) => h('button', { class: 'mini', title, onclick: (e) => { e.stopPropagation(); updateTask(task.id, { ...changes, seen: true }); } }, label);
  const next = first('todo'); const later = first('later');
  return h('div', { class: 'triage' },
    btn('להיום', 'תכנן להיום', { when: today(), ...(next && { status: next.id }) }),
    next ? btn(next.label, gx`העבר ל״${next.label}״`, { status: next.id }) : null,
    later ? btn(later.label, gx`העבר ל״${later.label}״`, { status: later.id }) : null);
}

// One quiet metadata line, secondary label colour, items separated by "·" (HIG: labels: label colours carry
// importance; HIG: color: blue stays reserved for things you can tap — tags are not links).
/** "בית · על מאיה" / "אישי" — only when the list mixes spaces. */
export function spaceChip(task, { always = false } = {}) {
  if (!state.multi || (!always && currentSpace() !== 'all')) return null;
  const kind = kindOfSpace(task);
  if (kind === 'work' && !always) return null;
  const s = spaceInfo(spaceOf(task));
  const on = kind === 'home' && task.assignee ? (task.assignee === state.me?.id ? 'עליי' : `על ${personName(task.assignee)}`) : null;
  return h('span', { class: `meta-item space-chip space-${kind}`, title: s?.label || '' }, icon(kind === 'home' ? 'home' : kind === 'personal' ? 'user' : 'briefcase', 13), s?.label || '', on ? ` · ${on}` : '');
}

function rowMeta(task, { showStatus, showProject, showKind = true }) {
  const parts = [];
  const t = today();
  const add = (el) => { if (el) parts.push(el); };
  // Mixed list ("הכל"): personal and home tasks say so; work is the default and stays unmarked.
  add(spaceChip(task));
  // Status only when it says something: the default column ("הבא בתור") is the norm, not news.
  if (showStatus && !['inbox', 'todo'].includes(categoryOf(task))) { const s = statusOf(task.status); add(h('span', { class: `meta-item c-${s.color}` }, h('span', { class: 'dot' }), s.label)); }
  if (showProject) { const pr = projectOf(task.project); if (pr) add(h('span', { class: `meta-item c-${pr.color}` }, h('span', { class: 'dot' }), bdi(pr.name))); }
  const kind = kindOfTask(task);
  if (kind && showKind) add(h('span', { class: `meta-item kind kind-${kind.id}`, title: `${kind.label} — ${kind.hint}` }, icon(kind.icon, 13), kind.short));
  if (task.deadline) {
    const overdue = task.deadline < t && !isDone(task);
    // "עד …" reads as a deadline without decoding the icon; the work day reads as a plain date.
    add(h('span', { class: ['meta-item', overdue && 'is-danger', task.deadline === t && 'is-strong'], title: 'דדליין' }, icon('flag', 13), `עד ${niceDate(task.deadline)}`));
  }
  if (task.when && task.when !== task.deadline) {
    // A work day that already passed is "carried" (נגרר), never overdue — only a passed deadline is.
    const carried = task.when < t && !isDone(task);
    add(h('span', { class: ['meta-item', task.when === t && !isDone(task) && 'is-strong', carried && 'is-warn'], title: carried ? 'תוכנן ליום שעבר' : 'מתוכנן ל' }, icon('calendar', 13), carried ? `נגרר מ־${niceDate(task.when)}` : niceDate(task.when)));
  }
  const r = nextReminder(task);
  if (r) add(h('span', { class: ['meta-item', r.last_error && 'is-danger'], title: r.last_error ? `שליחה נכשלה: ${r.last_error}` : 'תזכורת' }, icon(r.nag ? 'repeat' : 'bell', 13), h('span', { class: 'num', dir: 'ltr' }, localTime(r.at)), localDate(r.at) === t ? '' : ` ${niceDate(localDate(r.at))}`));
  const pg = progress(task);
  if (pg.total) add(h('span', { class: ['meta-item', pg.done === pg.total && 'is-success'], title: 'שלבים' }, icon('checkCircle', 13), h('span', { class: 'num' }, `${pg.done}/${pg.total}`)));
  fieldsFor(task).filter((f) => f.id !== 'kind' && f.showOnCard && task.fields[f.id] !== undefined && task.fields[f.id] !== '').forEach((f) => {
    const v = task.fields[f.id];
    // People are links: tapping a name shows everything with that person (search covers the field).
    if (f.id === 'with') { add(h('span', { class: 'meta-item people' }, icon('users', 13), String(v).split(/[,،]/).map((x) => x.trim()).filter(Boolean).map((name) => h('button', { class: 'person-link', title: `כל המשימות עם ${name}`, onclick: (e) => { e.stopPropagation(); setState({ search: name, openTask: null }); document.querySelector('.main')?.scrollTo({ top: 0 }); } }, bdi(name))))); return; }
    add(h('span', { class: 'meta-item' }, `${f.label}: `, bdi(f.type === 'checkbox' ? (v ? '✓' : '✗') : f.type === 'date' ? niceDate(v) : String(v))));
  });
  // No "·" separators: when the line wraps they dangle; each item already starts with an icon or dot.
  return parts;
}

// Tags that only repeat other information (the project, or a relative date like "שבוע הבא" that goes stale)
// are hidden in lists — the data is untouched, they still show in the task sheet.
const DATE_WORDS = /^(היום|מחר|מחרתיים|השבוע|שבוע הבא|בשבוע הבא|החודש|חודש הבא|סוף השבוע|דחוף)$/;
export function visibleTags(task) {
  const pr = projectOf(task.project);
  const same = new Set([pr?.id, pr?.name, ...(pr?.aliases || [])].filter(Boolean).map((x) => String(x).toLowerCase()));
  return task.tags.filter((t) => !DATE_WORDS.test(t) && !same.has(t.toLowerCase()));
}

// ---- Swipe actions on touch (HIG: designing for ios: "swipe … to initiate actions in a list row") ----
// RTL: swipe left → "done" revealed on the right (leading) edge; swipe right → planning actions on the left.
let openSwipe = null;
export function closeOpenSwipe(except) { if (openSwipe && openSwipe !== except) { openSwipe.close(); openSwipe = null; } }
document.addEventListener('pointerdown', (e) => { if (openSwipe && !openSwipe.el.contains(e.target)) closeOpenSwipe(); }, true);

const nextSunday = (d) => nextWeekStart(d);

// Swipe LEFT = dates (time runs right→left, like the timeline, so pushing a row left pushes it later).
// Swipe RIGHT = statuses. Done is the round check; it doesn't need a gesture too.
/** Change a task's work day, with undo — or, past its deadline, an offer to move the deadline too. */
export async function moveTask(task, when, label = 'הועבר') {
  const prev = task.when;
  const saved = await updateTask(task.id, { when, seen: true });
  if (!saved) return;
  const late = task.deadline && when && when > task.deadline;
  if (late) toast(`${label} → ${niceDate(when)}, אבל הדדליין ${niceDate(task.deadline)} נשאר`, { tone: 'error', iconName: 'flag', timeout: 10000, action: { label: 'להזיז גם את הדדליין', fn: () => updateTask(task.id, { deadline: when }) } });
  else toast(when ? `${label} → ${niceDate(when)}` : 'התאריך הוסר', { iconName: 'calendar', action: { label: 'ביטול', fn: () => updateTask(task.id, { when: prev }) } });
}

// ---- Row actions menu ("⋯", long press, right-click): everything a swipe does, without a gesture ----
let menuHost = null;
export function closeActions() { menuHost?.remove(); menuHost = null; }
window.addEventListener('hashchange', closeActions);
export function openActions(task) {
  closeActions();
  const t = today();
  const done = () => closeActions();
  const item = (label, iconName, run, { tone, current } = {}) => h('button', { class: ['as-item', tone && `tone-${tone}`, current && 'current'], role: 'menuitem', disabled: current || null, onclick: () => { done(); run(); } }, icon(iconName, 18), h('span', {}, label));
  const group = (title, items, chips = false) => h('div', { class: ['as-group', chips && 'as-chips'], role: 'group', 'aria-label': title }, h('div', { class: 'as-title' }, title), chips ? h('div', { class: 'as-chip-row' }, items) : items);
  const pick = h('input', { type: 'date', class: 'date-input as-date', 'aria-label': gx`בחר תאריך עבודה`, value: task.when || '', onchange: (e) => { done(); moveTask(task, e.target.value || null, 'הועבר'); } });
  const dates = [
    task.when !== t ? item('היום', 'sun', () => moveTask(task, t, 'להיום')) : null,
    item(nextWorkday(t) === addDays(t, 1) ? 'מחר' : `יום ${DAYS_SHORT[dow(nextWorkday(t))]}`, 'calendar', () => moveTask(task, nextWorkday(t), 'נדחה')),
    item('שבוע הבא', 'calendar', () => moveTask(task, nextSunday(t), 'לשבוע הבא')),
    task.when ? item('בלי תאריך', 'x', () => moveTask(task, null)) : null,
  ].filter(Boolean);
  const STATUS_ICON = { active: 'zap', todo: 'list', later: 'hourglass', done: 'checkCircle', inbox: 'inbox' };
  const statuses = orderedStatuses().filter((s) => s.category !== 'inbox').map((s) => item(s.label, s.id === 'waiting' ? 'pause' : STATUS_ICON[s.category], () => setStatus(task, s.id), { current: s.id === task.status, tone: s.category === 'done' ? 'success' : null }));
  const current = kindOfTask(task);
  const kinds = state.schema.fields.some((f) => f.id === 'kind') ? KINDS.map((k) => item(k.short, k.icon, () => updateTask(task.id, { fields: { kind: k.label } }), { current: current?.id === k.id })) : [];
  const sheet = h('div', { class: 'action-sheet', role: 'menu', 'aria-label': `פעולות: ${task.title}` },
    h('div', { class: 'as-head' }, h('div', { class: 'as-task' }, bdi(task.title)), h('button', { class: 'icon-btn small', 'aria-label': gx`סגור`, onclick: done }, icon('x', 16))),
    h('button', { class: 'as-open', onclick: () => { done(); openTask(task.id); } }, icon('external', 16), gx`פתח את המשימה`),
    group('מתי', [...dates, h('label', { class: 'as-item as-pick' }, icon('calendar', 18), h('span', {}, 'תאריך…'), pick)], true),
    group('סטטוס', statuses),
    kinds.length ? group('סוג עבודה', kinds, true) : null);
  // After a long press the finger lifts over the new overlay: that release is not a tap on the backdrop.
  const openedAt = Date.now();
  menuHost = h('div', { class: 'as-host', onclick: (e) => { if (e.target === menuHost && Date.now() - openedAt > 450) done(); }, onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } } }, sheet);
  document.body.append(menuHost);
  sheet.querySelector('.as-open').focus();
}

function swipeActions(task) {
  const t = today();
  const w = task.when;
  const act = (label, iconName, tone, run) => ({ run, el: h('button', { class: `swipe-btn tone-${tone}`, onclick: (e) => { e.stopPropagation(); closeOpenSwipe(); run(); } }, icon(iconName, 20), h('span', {}, label)) });
  const move = (label, when) => () => moveTask(task, when, label);

  const dayLabel = (d) => (d === addDays(t, 1) ? 'מחר' : `יום ${DAYS_SHORT[dow(d)]}`);
  const todayBtn = act('היום', 'sun', 'd-today', move('להיום', t));
  let dates; // first = primary (also the long-swipe action)
  if (!w || w < t) dates = [act(dayLabel(nextWorkday(t)), 'calendar', 'd-move', move('נדחה', nextWorkday(t))), todayBtn, act('שבוע הבא', 'calendar', 'd-week', move('לשבוע הבא', nextSunday(t)))];
  else if (w === t) dates = [act(dayLabel(nextWorkday(t)), 'calendar', 'd-move', move('נדחה', nextWorkday(t))), act('שבוע הבא', 'calendar', 'd-week', move('לשבוע הבא', nextSunday(t)))];
  else if (w < nextSunday(t)) dates = [act(gx`דחה ביום`, 'calendar', 'd-move', move('נדחה ביום', nextWorkday(w))), todayBtn, act('שבוע הבא', 'calendar', 'd-week', move('לשבוע הבא', nextSunday(t)))];
  else dates = [act(gx`דחה ביום`, 'calendar', 'd-move', move('נדחה ביום', nextWorkday(w))), todayBtn, act(gx`דחה בשבוע`, 'calendar', 'd-week', move('נדחה בשבוע', addDays(w, 7)))];
  const STATUS_ICON = { active: 'zap', todo: 'list', later: 'hourglass' };
  const statuses = orderedStatuses()
    .filter((s) => s.id !== task.status && ['todo', 'active', 'later'].includes(s.category))
    .slice(0, 4)
    .map((s) => act(s.label, s.id === 'waiting' ? 'pause' : STATUS_ICON[s.category], s.color, () => setStatus(task, s.id)));
  // The long swipe is a blind gesture: never let it carry a task past its deadline (the buttons still can, with a warning).
  const primaryDate = (!w || w <= t) ? nextWorkday(t) : nextWorkday(w);
  const longOk = !(task.deadline && primaryDate > task.deadline);
  return { lead: dates, trail: statuses, longOk };
}

// Fluid swipe (Apple motion guidance: 1:1 tracking, rubber-band edges, decide by velocity + projected landing point,
// spring that inherits the finger's velocity, and a row can be grabbed mid-flight).
export function attachSwipe(wrap, row, leadW, trailW, onFullLead, longOk = true) {
  let x = 0; let base = 0; let x0 = 0; let y0 = 0; let active = false; let decided = false; let horizontal = false; let moved = false;
  let anim = null;
  const vel = velocityTracker();
  const width = () => wrap.offsetWidth || 360;
  let armed = false;
  const paint = (v) => {
    x = v; row.style.transform = Math.abs(v) < 0.5 ? '' : `translate3d(${v}px,0,0)`; wrap.classList.toggle('open-lead', v < -0.5); wrap.classList.toggle('open-trail', v > 0.5);
    // Past the long-swipe point the primary action stretches across (and a tick on devices that can) — so letting
    // go is a decision, not a surprise (Apple motion guidance §8, §13).
    const arm = longOk && active && v < -width() * 0.55;
    if (arm !== armed) { armed = arm; wrap.classList.toggle('armed', arm); if (arm) navigator.vibrate?.(10); }
  };
  const springTo = (target, velocity = 0, then) => {
    anim?.stop();
    anim = spring({ from: x, to: target, velocity, damping: 1, response: 0.32, onUpdate: paint, onDone: then });
  };
  const api = { el: wrap, close() { base = 0; springTo(0); } };
  // Allowed range: the panels' width, then progressive resistance (rubber-band) instead of a hard stop.
  const clampSoft = (v) => {
    const minLead = -width(); // a long swipe left may travel (it postpones)
    if (v > trailW) return trailW + rubberband(v - trailW, width());
    if (v < minLead) return minLead + rubberband(v - minLead, width());
    return v;
  };
  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    // Grab it mid-flight: stop the spring and continue from where it is on screen.
    if (anim && !anim.done) { base = anim.stop(); anim = null; } else base = x;
    x0 = e.clientX; y0 = e.clientY; active = true; decided = false; horizontal = false; moved = false;
    vel.reset(); vel.add(e.clientX);
    row.classList.add('pressed');
  });
  row.addEventListener('pointermove', (e) => {
    if (!active) return;
    const mx = e.clientX - x0; const my = e.clientY - y0;
    vel.add(e.clientX);
    if (!decided) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return; // ~10px hysteresis before committing to a direction
      decided = true; horizontal = Math.abs(mx) > Math.abs(my) * 1.6; // a sloppy diagonal is a scroll
      row.classList.remove('pressed');
      if (horizontal) { row.setPointerCapture(e.pointerId); closeOpenSwipe(api); }
    }
    if (!horizontal) return;
    moved = true;
    paint(clampSoft(base + mx)); // 1:1 with the finger, from where it was grabbed
  });
  const end = () => {
    row.classList.remove('pressed');
    if (!active) return;
    active = false;
    if (!horizontal) return;
    const v = vel.velocity();
    const landing = x + project(v, 0.99); // where the flick is heading
    // Long swipe left (by distance or a hard flick) runs the primary date action.
    if (longOk && (x < -width() * 0.55 || (landing < -width() * 0.7 && v < -900))) {
      springTo(-width(), v, () => { onFullLead(); base = 0; paint(0); wrap.classList.remove('armed'); armed = false; });
      openSwipe = null;
      return;
    }
    // A real flick commits in its direction (velocity sign decides, not position — Apple motion guidance quick ref);
    // a slow release snaps to whatever is nearest the projected landing point.
    const FLICK = 450;
    const target = v > FLICK ? (x < -1 ? 0 : trailW)
      : v < -FLICK ? (x > 1 ? 0 : -leadW)
        : landing < -leadW / 2 ? -leadW : landing > trailW / 2 ? trailW : 0;
    base = target;
    springTo(target, v);
    openSwipe = target ? api : null;
  };
  row.addEventListener('pointerup', end);
  row.addEventListener('pointercancel', end);
  // A drag, or a tap on an open row, never opens the task.
  row.addEventListener('click', (e) => { if (moved || base) { e.stopImmediatePropagation(); e.preventDefault(); if (!moved) api.close(); moved = false; if (!base) openSwipe = null; } }, true);
}

export function taskRow(task, { showStatus = true, showProject = true, triage = false, showKind = true } = {}) {
  const p = priorityOf(task.priority);
  const marks = task.priority === 'urgent' ? '!!' : task.priority === 'high' || p.rank <= 1 ? '!' : '';
  const row = h('div', {
    class: ['row', isDone(task) && 'done', isFresh(task) && 'fresh', state.openTask === task.id && 'selected'],
    dataset: { id: task.id },
    tabindex: 0,
    role: 'button',
    onclick: () => openTask(task.id),
    onkeydown: (e) => { if (e.key === 'Enter') openTask(task.id); if (e.key === ' ') { e.preventDefault(); toggleDone(task); } },
  },
  checkButton(task),
  h('div', { class: 'row-main' },
    h('div', { class: 'row-title' },
      marks ? h('span', { class: `prio-mark c-${p.color}`, title: `עדיפות ${p.label}`, 'aria-label': `עדיפות ${p.label}` }, marks) : null,
      bdi(task.title),
      isFresh(task) ? h('span', { class: 'badge-new' }, icon('chat', 11), 'חדש') : null),
    h('div', { class: 'row-meta' }, rowMeta(task, { showStatus, showProject, showKind })),
    // Tags get their own, quieter line: they're the least important detail and the most variable in length.
    (() => { const tags = visibleTags(task); return tags.length ? h('div', { class: 'row-tags' }, tags.slice(0, 3).map((x) => h('span', {}, `#${x}`)), tags.length > 3 ? h('span', { class: 'meta-more' }, `+${tags.length - 3}`) : null) : null; })(),
    triage && categoryOf(task) === 'inbox' ? triageButtons(task) : null),
  h('span', { class: 'row-id num' }, `#${task.id}`),
  h('button', { class: 'row-menu', 'aria-label': `פעולות: ${task.title}`, 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); openActions(task); } }, icon('more', 18)));
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); openActions(task); });
  // Long press (touch): the same menu. Cancelled by any movement — that's a swipe or a scroll.
  let press = null; let pressed = false;
  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    pressed = false; const x0 = e.clientX; const y0 = e.clientY;
    clearTimeout(press);
    press = setTimeout(() => { pressed = true; navigator.vibrate?.(10); openActions(task); }, 500);
    const cancel = (ev) => { if (ev.type !== 'pointermove' || Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) { clearTimeout(press); row.removeEventListener('pointermove', cancel); } };
    row.addEventListener('pointermove', cancel); row.addEventListener('pointerup', cancel, { once: true }); row.addEventListener('pointercancel', cancel, { once: true });
  });
  row.addEventListener('click', (e) => { if (pressed) { pressed = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  const { lead, trail, longOk } = swipeActions(task);
  const wrap = h('div', { class: 'swipe' },
    h('div', { class: 'swipe-actions lead' }, lead.map((a) => a.el)),
    h('div', { class: 'swipe-actions trail' }, trail.map((a) => a.el)),
    row);
  // A long swipe left runs the first date action (postpone), with undo in the toast.
  attachSwipe(wrap, row, lead.length * 76, trail.length * 76, () => lead[0].run(), longOk);
  return wrap;
}

export function taskCard(task) {
  const p = priorityOf(task.priority);
  const nextStep = task.steps.find((s) => !s.done);
  return h('article', {
    class: ['card', isDone(task) && 'done', isFresh(task) && 'fresh', `edge-${p.color}`],
    dataset: { id: task.id },
    draggable: 'true',
    tabindex: 0,
    onclick: () => openTask(task.id),
    onkeydown: (e) => { if (e.key === 'Enter') openTask(task.id); },
  },
  h('div', { class: 'card-title' }, checkButton(task), bdi(task.title)),
  nextStep ? h('div', { class: 'card-next' }, icon('chevron', 12), bdi(nextStep.text)) : null,
  h('div', { class: 'row-meta' }, rowMeta(task, { showStatus: false, showProject: true })),
  (() => { const tags = visibleTags(task); return tags.length ? h('div', { class: 'row-tags' }, tags.slice(0, 3).map((x) => h('span', {}, `#${x}`))) : null; })());
}

export function emptyState(title, text, iconName = 'sparkles') {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon(iconName, 26)), h('h3', {}, title), text ? h('p', {}, text) : null);
}

// ---- Quick capture with a light Hebrew syntax ----
const DAY_WORDS = Object.fromEntries(DAYS.map((d, i) => [d, i]));
export function parseQuick(text) {
  const out = { title: text, tags: [], priority: null, when: null, project: null };
  const tokens = [];
  out.title = text.replace(/(^|\s)(!{1,2})(?=\s|$)/g, (m, sp, bang) => { out.priority = bang.length === 2 ? 'urgent' : 'high'; tokens.push(bang === '!!' ? 'דחוף' : 'גבוהה'); return ' '; });
  out.title = out.title.replace(/(^|\s)#([^\s#]+)/g, (m, sp, tag) => { out.tags.push(tag); return ' '; });
  out.title = out.title.replace(/(^|\s)@(?:יום[- ]?)?([^\s]+)/g, (m, sp, word) => {
    const t = today();
    let d = null;
    if (word === 'היום') d = t;
    else if (word === 'מחר') d = addDays(t, 1);
    else if (word === 'מחרתיים') d = addDays(t, 2);
    else if (word in DAY_WORDS) { const diff = (DAY_WORDS[word] - dow(t) + 7) % 7 || 7; d = addDays(t, diff); }
    else {
      const dm = word.match(/^(\d{1,2})[./](\d{1,2})$/);
      if (dm) { const y = Number(t.slice(0, 4)); let cand = `${y}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`; if (cand < t) cand = `${y + 1}${cand.slice(4)}`; d = cand; }
    }
    if (!d) return m;
    out.when = d;
    return ' ';
  });
  out.title = out.title.replace(/(^|\s)\+([^\s]+)/g, (m, sp, name) => {
    const p = state.schema.projects.find((x) => !x.archived && (x.id === name || x.name.startsWith(name) || x.name.replace(/\s+/g, '-').startsWith(name)));
    if (!p) return m;
    out.project = p.id;
    return ' ';
  });
  out.title = out.title.replace(/\s+/g, ' ').trim();
  out.tokens = tokens;
  return out;
}

export function quickAdd({ defaults = {}, placeholder = 'משימה חדשה…', autofocus = false, key = placeholder } = {}) {
  const preview = h('div', { class: 'qa-preview' });
  const input = h('input', { class: 'qa-input', dataset: { key: `qa-${key}` }, placeholder, dir: 'auto', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'הוספת משימה מהירה' });
  const renderPreview = () => {
    const q = parseQuick(input.value);
    const chips = [];
    if (q.priority) chips.push(h('span', { class: 'chip chip-warn' }, icon('flag', 12), q.priority === 'urgent' ? 'דחוף' : 'גבוהה'));
    if (q.when) chips.push(h('span', { class: 'chip chip-accent' }, icon('calendar', 12), niceDate(q.when)));
    if (q.project) chips.push(h('span', { class: 'chip' }, icon('folder', 12), projectOf(q.project).name));
    q.tags.forEach((t) => chips.push(h('span', { class: 'tag' }, `#${t}`)));
    preview.replaceChildren(...chips);
    preview.classList.toggle('show', chips.length > 0);
  };
  input.addEventListener('input', renderPreview);
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { input.value = ''; renderPreview(); input.blur(); }
    if (e.key !== 'Enter' || e.isComposing) return;
    const q = parseQuick(input.value);
    if (!q.title) return;
    input.disabled = true;
    const task = await createTask({ ...defaults, title: q.title, tags: [...(defaults.tags || []), ...q.tags], ...(q.priority && { priority: q.priority }), ...(q.when && { when: q.when }), ...(q.project && { project: q.project }) });
    input.disabled = false;
    if (task) { input.value = ''; renderPreview(); input.focus(); }
  });
  if (autofocus) requestAnimationFrame(() => input.focus());
  return h('div', { class: 'quick-add' },
    h('div', { class: 'qa-row' }, h('span', { class: 'qa-plus' }, icon('plus', 18)), input,
      h('span', { class: 'qa-hint', title: '#תגית  !חשוב  !!דחוף  @מחר  @ראשון  @15.10  +פרויקט' }, h('kbd', {}, 'Enter'))),
    preview);
}
