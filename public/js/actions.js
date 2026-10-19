import { api } from './api.js';
import { beginWrite, dropTask, endWrite, firstStatus, isDone, putTask, setState, state, newTaskSpace, gx } from './store.js';
import { h, icon } from './util.js';
import { project, spring, velocityTracker } from './motion.js';

// ---- Toasts ----
export function toast(message, { action, tone = 'info', timeout = 8000, iconName } = {}) {
  const host = document.querySelector('#toasts');
  const el = h('div', { class: `toast toast-${tone}` },
    iconName ? icon(iconName, 16) : null,
    h('span', { class: 'toast-text' }, message),
    action ? h('button', { class: 'toast-action', onclick: () => { action.fn(); el.remove(); } }, action.label) : null,
    h('button', { class: 'toast-close', 'aria-label': gx`סגור`, onclick: () => el.remove() }, icon('x', 14)));
  host.append(el);
  // Never let toasts pile up over the screen.
  while (host.children.length > 3) host.firstElementChild.remove();
  requestAnimationFrame(() => el.classList.add('in'));
  const fadeOut = () => { el.classList.remove('in'); setTimeout(() => el.remove(), 300); };
  let timer = setTimeout(fadeOut, timeout);
  // Long enough to reach "ביטול" with VoiceOver or Switch Control: the clock stops while the toast is touched/focused.
  const hold = () => clearTimeout(timer);
  const resume = () => { clearTimeout(timer); timer = setTimeout(fadeOut, 4000); };
  el.addEventListener('focusin', hold); el.addEventListener('focusout', resume);
  el.addEventListener('mouseenter', hold); el.addEventListener('mouseleave', resume);
  // Flick a toast away (sideways or down); a drag that doesn't commit springs back and restarts the timer.
  const vel = { x: velocityTracker(), y: velocityTracker() };
  let start = null; let pos = { x: 0, y: 0 };
  const paint = () => { el.style.transform = `translate3d(${pos.x}px,${Math.max(0, pos.y)}px,0)`; el.style.opacity = String(1 - Math.min(1, Math.max(Math.abs(pos.x) / el.offsetWidth, pos.y / 80))); };
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    clearTimeout(timer);
    start = { x: e.clientX, y: e.clientY }; vel.x.reset(); vel.y.reset();
    el.setPointerCapture(e.pointerId); el.style.transition = 'none';
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    vel.x.add(e.clientX); vel.y.add(e.clientY);
    pos = { x: e.clientX - start.x, y: e.clientY - start.y };
    paint();
  });
  const release = () => {
    if (!start) return;
    start = null;
    const vx = vel.x.velocity(); const vy = vel.y.velocity();
    const away = Math.abs(pos.x + project(vx, 0.99)) > el.offsetWidth / 2 || pos.y + project(vy, 0.99) > 60;
    // X and Y are separate springs (§3) so a diagonal flick stays on its path.
    const tx = away ? (Math.abs(pos.x) > pos.y ? Math.sign(pos.x + vx || 1) * el.offsetWidth * 1.2 : pos.x) : 0;
    const ty = away && Math.abs(pos.x) <= pos.y ? 140 : 0;
    let left = 2;
    const settle = () => { if (--left) return; if (away) el.remove(); else { el.style.transition = ''; el.style.transform = ''; el.style.opacity = ''; timer = setTimeout(fadeOut, timeout); } };
    spring({ from: pos.x, to: tx, velocity: vx, damping: 1, response: 0.3, onUpdate: (v) => { pos.x = v; paint(); }, onDone: settle });
    spring({ from: pos.y, to: ty, velocity: vy, damping: 1, response: 0.3, onUpdate: (v) => { pos.y = v; paint(); }, onDone: settle });
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
}
/** Errors in the interface's language: a network failure is "no connection", not a browser's English message. */
export function errorText(error) {
  if (error?.offline) return error.message;
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(error?.message || '')) return gx`אין חיבור — השינוי לא נשמר. נסה שוב כשהחיבור יחזור.`;
  return error?.message || 'הפעולה נכשלה';
}
export const fail = (error) => toast(errorText(error), { tone: 'error', iconName: 'x' });

// ---- Mutations: optimistic locally, then reconciled with the server's version ----
export async function updateTask(id, changes, { silent = true, quiet = false } = {}) {
  const current = state.tasks.get(id);
  // A team-board task's due date only moves with a reason: it is recorded there and shown to the reviewer.
  if (current?.org && !current.org.gone && changes.deadline !== undefined && current.deadline && changes.deadline !== current.deadline) {
    const reason = prompt(gx`זו משימה ארגונית — למה היעד זז? (הסיבה נשמרת בלוח הצוות ונשלחת למבקר/ת)`);
    if (!reason?.trim()) { putTask({ ...current }); return null; }
    changes = { ...changes, org_reason: reason.trim() };
  }
  const known = state.tasks.has(id);
  const handle = known ? beginWrite(id, changes) : null;
  try {
    const saved = await api.update(id, changes);
    if (handle) endWrite(id, handle, { ok: true });
    putTask(saved);
    if (!silent) toast('נשמר', { iconName: 'check' });
    return saved;
  } catch (error) {
    // `quiet` updates (e.g. marking as seen) keep showing the change: rolling back would re-trigger them.
    if (quiet) return null;
    if (handle) endWrite(id, handle);
    // Don't restore an old snapshot (it may predate later confirmed edits) — ask the server what is true now.
    try { putTask(await api.get(id)); } catch { /* offline: the confirmed state is already shown */ }
    fail(error);
    return null;
  }
}

export async function createTask(input) {
  try {
    // A new task lands in the space being looked at (or my work space when the list shows everything).
    const space = input.space ?? newTaskSpace();
    const task = await api.create(space ? { ...input, space } : input);
    putTask(task);
    return task;
  } catch (error) { fail(error); return null; }
}

export async function toggleDone(task) {
  const wasDone = isDone(task);
  const previous = task.status;
  const status = wasDone ? (firstStatus('todo') || firstStatus('inbox')) : firstStatus('done');
  const saved = await updateTask(task.id, { status, seen: true });
  if (saved && !wasDone) {
    toast(`בוצע: ${task.title}`, { iconName: 'checkCircle', tone: 'success', action: { label: 'ביטול', fn: () => updateTask(task.id, { status: previous }) } });
  }
}

export async function setStatus(task, status) {
  const previous = task.status;
  const saved = await updateTask(task.id, { status, seen: true });
  if (saved) {
    const label = state.schema.statuses.find((s) => s.id === status)?.label;
    toast(`הועבר ל״${label}״`, { action: { label: 'ביטול', fn: () => updateTask(task.id, { status: previous }) } });
  }
}

export async function archiveTask(task) {
  const saved = await updateTask(task.id, { archived: !task.archived });
  if (saved) toast(saved.archived ? 'הועבר לארכיון' : 'הוחזר מהארכיון', { iconName: 'archive', action: { label: 'ביטול', fn: () => updateTask(task.id, { archived: task.archived }) } });
}

export async function deleteTask(task) {
  try {
    await api.remove(task.id);
    dropTask(task.id);
    toast(`נמחקה: ${task.title}`, {
      iconName: 'trash',
      action: { label: 'שחזור', fn: async () => { const { items } = await api.activity(task.id, 5); const entry = items.find((a) => a.action === 'delete'); if (entry) putTask(await api.undo(entry.id), { revive: true }); } },
    });
  } catch (error) { fail(error); }
}

/** `quiet`: part of a batch — no toast per item, and failures are thrown to the caller instead of shown. */
export async function undoActivity(entry, { quiet = false } = {}) {
  try {
    const result = await api.undo(entry.id);
    if (result?.schema) setState({ schema: result.schema });
    else if (result?.deleted) dropTask(result.id);
    else if (result?.id) putTask(result, { revive: true });
    if (!quiet) toast('הפעולה בוטלה', { iconName: 'undo' });
    await refreshActivity();
    setState({});
  } catch (error) { if (quiet) throw error; fail(error); }
}

export async function refreshActivity() {
  try { state.activity = (await api.activity(null, 60)).items; } catch { /* offline */ }
}

/**
 * Saves a structure change given as a function of the current schema. If an agent changed the structure meanwhile
 * (409), re-reads it and re-applies the same change, so neither side's edit is lost.
 */
export async function saveSchema(mutate, message = 'המבנה נשמר') {
  const attempt = (base) => { const next = structuredClone(base); return mutate(next) || next; };
  try {
    let saved;
    try { saved = await api.schema(attempt(state.schema)); } catch (error) {
      if (error.status !== 409) throw error;
      const fresh = await api.getSchema();
      setState({ schema: fresh });
      saved = await api.schema(attempt(fresh));
    }
    setState({ schema: saved });
    toast(message, { iconName: 'check', tone: 'success' });
    return saved;
  } catch (error) { fail(error); return null; }
}
