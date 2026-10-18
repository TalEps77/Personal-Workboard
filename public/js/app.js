import { api, connectEvents, setReadOnly } from './api.js';
import { createTask, refreshActivity, toast } from './actions.js';
import { openTask, parseQuick } from './components.js';
import { drawer, refreshDrawerActivity } from './drawer.js';
import { resetSettingsCache, settingsView } from './settings.js';
import { actorInfo, allTasks, confirmed, contextChoice, counts, currentKind, currentSpace, dropTask, isMine, isWorkHours, spaceInfo, isDone, matches, projectsHere, putTask, replaceTasks, setConfirmedListener, setState, setUi, sortTasks, state, statusOf, subscribe, gx, g, agentName } from './store.js';
import { refreshShopping, shoppingCount, shoppingView } from './shopping.js';
import { bdi, debounce, h, icon, setLocale } from './util.js';
import { project, reducedMotion, rubberband, spring, velocityTracker } from './motion.js';
import { activityView, doneView, listView, projectView, projectsView, searchView, todayView } from './views.js';
import { timelineView } from './timeline.js';

// Four places, same order in the sidebar and the phone tab bar (HIG: tab bars › Best practices: fewer tabs).
// "זמן פנוי" lives inside היום; the board is a layout of משימות. Old links (#/focus, #/board) still work.
const NAV = [
  { view: 'today', label: 'היום', icon: 'sun', key: '1', also: ['focus'] },
  { view: 'timeline', label: 'יומן', icon: 'calendar', key: '2' },
  { view: 'all', label: 'משימות', icon: 'list', key: '3', also: ['board'] },
  { view: 'projects', label: 'פרויקטים', icon: 'folder', key: '4', also: ['project'] },
];
// The tab bar follows the context: at home and in personal the fourth tab is shopping (that context's lists);
// at work and in "הכל" it's projects.
// (A context is a mode of the whole app — like a Focus — so its tabs may differ; within a context they never change.)
const SHOP_TAB = { view: 'shopping', label: 'קניות', icon: 'cart', key: '4' };
const navItems = () => (['home', 'personal'].includes(currentKind()) && state.shopping?.lists?.length ? [...NAV.slice(0, 3), SHOP_TAB] : NAV);
const navActive = (n, view) => n.view === view || (n.also || []).includes(view);

// ---------------- Routing ----------------
function parseHash() {
  const [, view = 'today', param = null] = (location.hash || '#/today').split('/');
  return { view: view || 'today', param: param ? decodeURIComponent(param) : null };
}
function onRoute() {
  const r = parseHash();
  if (r.view === 'task') {
    setState({ openTask: r.param });
    return;
  }
  closeNav();
  if (document.activeElement?.classList.contains('search-input')) document.activeElement.blur();
  // Closing a task returns to the same screen: keep the search (checking 5 results shouldn't mean typing it 5 times).
  const sameScreen = r.view === state.route.view && r.param === state.route.param;
  setState({ route: { ...r, hash: location.hash || '#/today' }, openTask: null, search: sameScreen ? state.search : '' });
  if (!sameScreen) document.querySelector('.main')?.scrollTo({ top: 0 });
}

// ---------------- Rendering ----------------
function navItem(href, label, iconName, { active, count, badge, color } = {}) {
  return h('a', { class: ['nav-item', active && 'active'], href, 'aria-current': active ? 'page' : null },
    color ? h('span', { class: `dot c-${color}` }) : icon(iconName, 18),
    h('span', { class: 'nav-label' }, bdi(label)),
    badge ? h('span', { class: 'nav-badge', title: 'חדשות מ־WhatsApp' }, badge) : null,
    count ? h('span', { class: 'nav-count num' }, count) : null);
}

function sidebar() {
  const c = counts();
  const r = state.route;
  const open = allTasks().filter((t) => !isDone(t));
  return h('nav', { class: 'sidebar', 'aria-label': 'ניווט' },
    h('div', { class: 'brand' }, h('img', { class: 'brand-icon', src: '/icons/icon-192.png', alt: '', width: 30, height: 30 }), h('span', { class: 'brand-name' }, state.schema.title || 'Workboard')),
    h('div', { class: 'nav-group' },
      navItems().map((n) => navItem(`#/${n.view}`, n.label, n.icon, { active: navActive(n, r.view) && r.view !== 'project', count: n.view === 'today' ? c.today : n.view === 'all' ? c.open : n.view === 'shopping' ? shoppingCount() || null : null })),
      // Unsorted only appears when Hermes couldn't place something.
      // Outside work, the shopping list is one click away on the desktop too (at home it's already a tab).
      state.shopping && currentKind() === 'all' ? navItem('#/shopping', 'קניות', 'cart', { active: r.view === 'shopping', count: shoppingCount() || null }) : null,
      c.inbox ? navItem('#/inbox', state.schema.statuses.find((s) => s.category === 'inbox')?.label || 'לא ממוין', 'inbox', { active: r.view === 'inbox', badge: c.inbox }) : null),
    projectsHere().some((p) => !p.archived) ? h('div', { class: 'nav-group' }, h('div', { class: 'nav-heading' }, 'פרויקטים'),
      projectsHere().filter((p) => !p.archived).map((p) => navItem(`#/project/${p.id}`, p.name, null, { color: p.color, active: r.view === 'project' && r.param === p.id, count: open.filter((t) => t.project === p.id).length || null }))) : null,
    state.schema.views.length ? h('div', { class: 'nav-group' }, h('div', { class: 'nav-heading' }, 'תצוגות'),
      state.schema.views.map((v) => navItem(`#/view/${v.id}`, v.name, 'star', { active: r.view === 'view' && r.param === v.id, count: open.filter((t) => matches(t, v.filter)).length || null }))) : null,
    h('div', { class: 'nav-group' }, navItem('#/activity', 'מה השתנה', 'zap', { active: r.view === 'activity' }), navItem('#/done', 'בוצעו וארכיון', 'checkCircle', { active: r.view === 'done' }), navItem('#/settings', 'מבנה והגדרות', 'settings', { active: r.view === 'settings' })),
    h('div', { class: 'sidebar-foot' },
      h('div', { class: ['conn', state.online ? 'on' : 'off'], title: state.online ? 'עדכונים חיים פעילים' : 'מנותק — מנסה להתחבר מחדש' }, h('span', { class: 'conn-dot' }), state.online ? 'חי' : 'מנותק',
        h('span', { class: 'conn-sep' }, '·'), icon('chat', 13), state.notifier.configured ? 'WhatsApp' : h('span', { class: 'danger' }, 'WhatsApp ✗')),
      h('div', { class: 'foot-actions' },
        h('button', { class: 'icon-btn', title: 'קיצורי מקלדת (?)', onclick: showShortcuts }, icon('keyboard', 16)))));
}

function topbar() {
  const search = h('input', { class: 'search-input', type: 'search', placeholder: 'חיפוש משימות…', value: state.search, dir: 'auto', dataset: { key: 'search' }, 'aria-label': 'חיפוש' });
  search.addEventListener('input', debounce(() => setState({ search: search.value }), 120));
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.value = ''; setState({ search: '' }); search.blur(); } });
  return h('div', { class: 'topbar' },
    h('button', { class: 'icon-btn menu-btn', 'aria-label': 'תפריט', onclick: () => (document.body.classList.contains('nav-open') ? closeNav() : openNav()) }, icon('menu', 20)),
    contextChip(),
    h('div', { class: 'search' }, icon('search', 16), search, h('kbd', { class: 'hide-sm' }, '/')),
    h('button', { class: 'btn ghost palette-btn desk-only', onclick: () => openPalette(), title: 'פקודות וחיפוש מהיר' }, icon('zap', 15), h('span', { class: 'hide-sm' }, 'פקודות'), h('kbd', { class: 'hide-sm' }, 'Ctrl K')),
    h('button', { class: 'btn primary desk-only', onclick: () => openPalette('new') }, icon('plus', 16), h('span', {}, 'משימה')));
}

// ---------------- Context (עבודה / אישי / בית / הכל) ----------------
// One control, always in the same place: a chip in the top bar showing where you are (colour + icon + name).
// Tapping it opens a short list of contexts; "אוטומטי" follows work hours. The whole app adapts to the context.
const CONTEXT_ICON = { work: 'briefcase', personal: 'user', home: 'home', all: 'layers' };
const contextLabel = (id) => (id === 'all' ? 'הכל' : spaceInfo(id)?.label || id);
function contextChip() {
  if (!state.multi) return null;
  const kind = currentKind();
  const auto = contextChoice() === 'auto';
  return h('button', { class: ['ctx-chip', `ctx-${kind}`], onclick: openContextSheet, 'aria-haspopup': 'dialog', 'aria-label': `הקשר: ${contextLabel(currentSpace())}${auto ? ' (אוטומטי)' : ''}. החלפה` },
    icon(CONTEXT_ICON[kind], 16), h('span', { class: 'ctx-name' }, contextLabel(currentSpace())), auto ? h('span', { class: 'ctx-auto' }, 'אוטו') : null, icon('chevronDown', 14, 'ctx-caret'));
}
function openContextSheet() {
  document.querySelector('.ctx-host')?.remove();
  const openedAt = Date.now();
  const close = () => host.remove();
  const choose = (id) => { setUi({ space: id }); close(); };
  const open = allTasks({ anySpace: true }).filter((t) => !isDone(t) && isMine(t));
  const countFor = (id) => (id === 'all' ? open.length : open.filter((t) => (t.space || 'work') === id).length);
  const DESC = { work: 'משימות העבודה, הלו״ז והפרויקטים', personal: 'דברים שלך — סידורים, קניות אישיות, Wish list', home: 'משימות הבית המשותפות, סופר ופארם', all: 'הכל ביחד, עם תווית לכל מרחב' };
  const choice = contextChoice();
  const row = (id, kind, label, desc, count) => h('button', { class: ['ctx-row', `ctx-${kind}`, choice === id && 'on'], role: 'menuitemradio', 'aria-checked': String(choice === id), onclick: () => choose(id) },
    h('span', { class: 'ctx-row-icon' }, icon(CONTEXT_ICON[kind], 20)),
    h('span', { class: 'ctx-row-text' }, h('span', { class: 'ctx-row-label' }, label), h('span', { class: 'ctx-row-desc' }, desc)),
    count !== null ? h('span', { class: 'ctx-row-count num' }, count || '') : null,
    choice === id ? icon('check', 18, 'ctx-row-check') : null);
  const autoNow = isWorkHours() ? 'עכשיו: עבודה' : 'עכשיו: הכל';
  const host = h('div', { class: 'as-host ctx-host', onclick: (e) => { if (e.target === host && Date.now() - openedAt > 450) close(); }, onkeydown: (e) => { if (e.key === 'Escape') close(); } },
    h('div', { class: 'action-sheet ctx-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'מעבר בין הקשרים' },
      h('div', { class: 'as-head' }, h('div', { class: 'as-task' }, gx`איפה את/ה עכשיו?`), h('button', { class: 'icon-btn small', 'aria-label': gx`סגור`, onclick: close }, icon('x', 16))),
      h('div', { class: 'ctx-list', role: 'menu' },
        state.spaces.map((x) => row(x.id, x.kind, x.label, DESC[x.kind], countFor(x.id))),
        row('all', 'all', 'הכל', DESC.all, countFor('all')),
        h('div', { class: 'ctx-sep' }),
        h('button', { class: ['ctx-row', 'ctx-auto-row', choice === 'auto' && 'on'], role: 'menuitemradio', 'aria-checked': String(choice === 'auto'), onclick: () => choose('auto') },
          h('span', { class: 'ctx-row-icon' }, icon('clock', 20)),
          h('span', { class: 'ctx-row-text' }, h('span', { class: 'ctx-row-label' }, 'אוטומטי'), h('span', { class: 'ctx-row-desc' }, `עבודה בא׳–ה׳ 8:00–17:00, הכל בשאר הזמן · ${autoNow}`)),
          choice === 'auto' ? icon('check', 18, 'ctx-row-check') : null))));
  document.body.append(host);
  host.querySelector('.ctx-row.on, .ctx-row')?.focus();
}

function currentView() {
  if (state.search.trim()) return searchView();
  const { view, param } = state.route;
  switch (view) {
    case 'today': return todayView();
    case 'focus': return todayView({ mode: 'focus' });
    case 'activity': return activityView();
    case 'inbox': return listView({ key: 'inbox', title: state.schema.statuses.find((s) => s.category === 'inbox')?.label || 'לא ממוין', subtitle: `משימות ש־${agentName()} לא היה בטוח איפה לשים. אפשר למיין כאן — או לענות לו בווטסאפ.`, filter: { category: ['inbox'] }, sort: 'created', emptyTitle: 'התיבה ריקה', emptyText: g(`משימות שתשלח ל־${agentName()} בווטסאפ ינחתו כאן.`, `משימות שתשלחי ל־${agentName()} בווטסאפ ינחתו כאן.`), rowOptions: { showStatus: false, triage: true }, hint: gx`החלק שורה ימינה כדי לקבוע סטטוס, או שמאלה כדי לקבוע תאריך` });
    case 'board': return listView({ key: 'all', title: 'משימות', group: 'when', groupable: true, forceLayout: matchMedia('(max-width: 820px)').matches ? null : 'board' });
    case 'all': return listView({ key: 'all', title: 'משימות', group: 'when', groupable: true });
    case 'upcoming':
    case 'timeline': return timelineView();
    case 'projects': return projectsView();
    case 'project': return projectView(param);
    case 'done': return doneView();
    case 'settings': return settingsView();
    case 'shopping': return shoppingView();
    case 'view': {
      const v = state.schema.views.find((x) => x.id === param);
      if (!v) return h('div', { class: 'view' }, h('h1', {}, 'התצוגה לא נמצאה'));
      return listView({ key: `view:${v.id}`, title: v.name, filter: v.filter, sort: v.sort, group: v.group, layout: v.layout, defaults: { ...(v.filter.status?.length === 1 && { status: v.filter.status[0] }), ...(v.filter.project?.length === 1 && { project: v.filter.project[0] }), ...(v.filter.tags?.length && { tags: v.filter.tags }) } });
    }
    default: return todayView();
  }
}

function captureFocus() {
  const el = document.activeElement;
  if (!el?.dataset?.key) return null;
  return { key: el.dataset.key, value: 'value' in el ? el.value : null, start: el.selectionStart, end: el.selectionEnd, type: el.type };
}
function restoreFocus(saved) {
  if (!saved) return;
  const el = document.querySelector(`[data-key="${CSS.escape(saved.key)}"]`);
  if (!el) return;
  // Never clobber what the user is typing with an older server echo.
  if (saved.value !== null && 'value' in el && el.value !== saved.value && el.type !== 'checkbox') el.value = saved.value;
  el.focus({ preventScroll: true });
  try { if (saved.start !== null && saved.start !== undefined) el.setSelectionRange(saved.start, saved.end); } catch { /* not a text input */ }
  el.dispatchEvent(new Event('input:restored'));
}

let lastDrawer = null;
let skippedSheetRender = false;
// The sheet skipped re-rendering while a field in it had focus: catch up as soon as focus leaves it.
document.addEventListener('focusout', (e) => {
  if (!skippedSheetRender || !e.target.closest?.('.drawer')) return;
  setTimeout(() => { const el = document.activeElement; if (!(el?.closest?.('.drawer') && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'))) { skippedSheetRender = false; setState({}); } }, 0);
});

function render() {
  if (!state.schema) return;
  const root = document.querySelector('#app');
  const focus = captureFocus();
  // <details> and per-column quick-add toggles survive re-renders.
  const openDetails = new Map([...document.querySelectorAll('details[data-key]')].map((d) => [d.dataset.key, d.open]));
  const shownAdds = new Set([...document.querySelectorAll('.column-add.show')].map((el) => el.closest('.column')?.dataset.status));
  const mainScroll = document.querySelector('.main')?.scrollTop || 0;
  const drawerScroll = document.querySelector('.drawer-scroll')?.scrollTop || 0;

  const task = state.openTask ? state.tasks.get(state.openTask) : null;
  // Never rebuild the sheet under a field that is being typed in: on iOS a replaced <input> drops the keyboard and
  // resets Hebrew suggestions. Keep the live sheet; it re-renders once focus leaves it (focusout below).
  // Only free text being edited (title, notes, an existing step, a reminder note) freezes the sheet; inputs whose
  // action IS the update (the step adder after Enter, checkboxes, pickers) must see it at once.
  const isTypingField = (el) => Boolean(el?.closest?.('.drawer')) && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search)?$/.test(el.getAttribute('type') || '') && !el.classList.contains('step-add')));
  const typing = isTypingField(document.activeElement);
  const liveHost = typing && lastDrawer === state.openTask ? document.querySelector('.drawer-host') : null;
  const drawerEl = liveHost ? null : task ? drawer(task) : state.openTask ? h('aside', { class: 'drawer' }, h('div', { class: 'drawer-scroll' }, h('p', { class: 'muted' }, `משימה #${state.openTask} לא נמצאה.`))) : null;
  const offline = state.offlineSince ? h('div', { class: 'degraded offline' }, icon('clock', 16), h('span', {}, `אין חיבור — מוצג המצב מ־${new Date(state.offlineSince).toLocaleString('he-IL', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}. קריאה בלבד; שינויים לא יישמרו.`), h('button', { class: 'btn small', onclick: () => location.reload() }, gx`נסה שוב`)) : null;
  const banner = state.degraded ? h('div', { class: 'degraded' }, icon('flag', 16), h('span', {}, 'קובץ המבנה (board.json) פגום — מוצג המבנה התקין האחרון, ושינויי מבנה חסומים. '),
    h('button', { class: 'btn small', onclick: async () => { try { const schema = await api.restoreSchema(); setState({ schema, degraded: null }); toast('המבנה שוחזר', { tone: 'success', iconName: 'check' }); } catch (e) { toast(e.message, { tone: 'error' }); } } }, gx`אשר את המבנה המוצג`)) : null;
  // The context colours the whole app (accent, Today's card) — you always know where you are.
  document.body.dataset.ctx = state.multi ? currentKind() : 'work';
  const main = h('main', { class: 'main', onscroll: (e) => e.currentTarget.firstElementChild?.classList.toggle('scrolled', e.currentTarget.scrollTop > 4) }, topbar(), offline, banner, h('div', { class: 'view-host' }, currentView()));
  const before = [sidebar(), main, h('div', { class: 'scrim', onclick: () => closeNav() })];
  const nav = mobileNav();
  if (liveHost) {
    // Swap everything around the live sheet without detaching it (detaching a focused field blurs it).
    for (const child of [...root.children]) if (child !== liveHost) child.remove();
    before.forEach((el) => root.insertBefore(el, liveHost));
    root.append(nav);
    skippedSheetRender = true;
  } else {
    root.replaceChildren(...before, ...(drawerEl ? [h('div', { class: 'drawer-host', role: 'dialog', 'aria-modal': 'true', 'aria-label': task ? `משימה: ${task.title}` : 'משימה', onclick: (e) => { if (e.target.classList.contains('drawer-host')) closeSheet(); } }, drawerEl)] : []), nav);
  }
  // While the sheet is open, the screen behind it is out of reach for VoiceOver and the keyboard.
  for (const el of [main, nav, before[0]]) el.inert = Boolean(state.openTask);
  const sheet = document.querySelector('.drawer');
  if (sheet && lastDrawer !== state.openTask) { animateSheetIn(); sheet.tabIndex = -1; sheet.focus({ preventScroll: true }); } // focus the dialog, not a field (that would raise the keyboard)
  else if (sheet) paintSheet(sheetOffset); // a re-render mid-animation keeps the live position
  lastDrawer = state.openTask;
  enableSheetSwipe(sheet);
  if (document.body.classList.contains('nav-open')) { paintNav(navOffset); enableNavSwipe(); }
  main.scrollTop = mainScroll;
  main.firstElementChild?.classList.toggle('scrolled', mainScroll > 4);
  const ds = document.querySelector('.drawer-scroll');
  if (ds && !liveHost) ds.scrollTop = drawerScroll;
  document.querySelectorAll('details[data-key]').forEach((d) => { if (openDetails.has(d.dataset.key)) d.open = openDetails.get(d.dataset.key); });
  document.querySelectorAll('.column').forEach((col) => { if (shownAdds.has(col.dataset.status)) col.querySelector('.column-add')?.classList.add('show'); });
  restoreFocus(focus);
  const c = counts();
  document.title = `${c.today ? `(${c.today}) ` : ''}${state.schema.title || 'Workboard'}`;
}

// ---------------- Task sheet motion (Apple motion guidance) ----------------
// Enter and exit along the same path (§7): up from the bottom on phones, in from the side on desktop.
// The sheet can be dragged 1:1, rubber-bands upward, and dismisses by velocity + projected landing (§5–§6, §9).
let sheetAnim = null;
let sheetOffset = 0; // live on-screen offset; survives re-renders (the DOM is rebuilt on every state change)
const isPhone = () => matchMedia('(max-width: 820px)').matches;
const currentSheet = () => document.querySelector('.drawer');
function paintSheet(v) {
  sheetOffset = v;
  const sheet = currentSheet();
  if (!sheet) return;
  const phone = isPhone();
  const size = phone ? sheet.offsetHeight : sheet.offsetWidth;
  // phone: positive = down; desktop (drawer on the left in RTL): positive = out to the left
  sheet.style.transform = Math.abs(v) < 0.5 ? '' : phone ? `translate3d(0,${v}px,0)` : `translate3d(${-v}px,0,0)`;
  sheet.parentElement.style.setProperty('--scrim', String(Math.max(0, Math.min(1, 1 - v / (size || 1)))));
}
const sheetSize = () => { const s = currentSheet(); return s ? (isPhone() ? s.offsetHeight : s.offsetWidth) : 0; };
function animateSheetIn() {
  sheetAnim?.stop();
  // Reduced motion: a short cross-fade instead of the slide (§14) — feedback stays, the vestibular motion goes.
  if (reducedMotion()) { paintSheet(0); currentSheet()?.animate([{ opacity: 0 }, { opacity: 1 }], 200); return; }
  paintSheet(sheetSize());
  sheetAnim = spring({ from: sheetSize(), to: 0, damping: 1, response: 0.38, onUpdate: paintSheet });
}
function closeSheet(velocity = 0) {
  const leave = () => { sheetOffset = 0; if (state.openTask) location.hash = state.route.hash || '#/today'; };
  if (!currentSheet()) { leave(); return; }
  if (reducedMotion()) { currentSheet().animate([{ opacity: 1 }, { opacity: 0 }], 160).onfinish = leave; return; }
  const from = sheetAnim && !sheetAnim.done ? sheetAnim.stop() : sheetOffset;
  sheetAnim = spring({ from, to: sheetSize(), velocity, damping: 1, response: 0.3, onUpdate: paintSheet, onDone: leave });
}
document.addEventListener('wb:close-sheet', () => closeSheet());

function enableSheetSwipe(sheet) {
  if (!sheet || !isPhone() || sheet.dataset.swipe) return;
  sheet.dataset.swipe = '1';
  const handle = sheet.querySelector('.drawer-head');
  const vel = velocityTracker();
  let startY = null; let base = 0; let dragging = false;
  // Tap and drag are recognised in parallel; once the finger travels ~10px it's a drag and the tap is cancelled
  // (Apple motion guidance §10) — so the sheet can be pulled from anywhere on its header, buttons included.
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    base = sheetAnim && !sheetAnim.done ? sheetAnim.stop() : sheetOffset; // grab mid-flight
    startY = e.clientY; dragging = false; vel.reset(); vel.add(e.clientY);
  });
  handle.addEventListener('pointermove', (e) => {
    if (startY === null) return;
    vel.add(e.clientY);
    const dy = e.clientY - startY;
    if (!dragging) { if (Math.abs(dy) < 10) return; dragging = true; handle.setPointerCapture(e.pointerId); }
    const raw = base + dy;
    paintSheet(raw < 0 ? rubberband(raw, sheet.offsetHeight) : raw); // resist upward, follow downward 1:1
  });
  const end = () => {
    if (startY === null) return;
    startY = null;
    if (!dragging) { if (base) sheetAnim = spring({ from: sheetOffset, to: 0, damping: 1, response: 0.32, onUpdate: paintSheet }); return; }
    const v = vel.velocity();
    const landing = sheetOffset + project(v, 0.99);
    // Dismiss on a downward flick, or when the projected landing is past 40% of the sheet; an upward flick keeps it.
    if (v > 600 || (v > -200 && landing > sheet.offsetHeight * 0.4)) closeSheet(Math.max(v, 0));
    else sheetAnim = spring({ from: sheetOffset, to: 0, velocity: v, damping: 1, response: 0.32, onUpdate: paintSheet });
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('click', (e) => { if (dragging) { e.stopPropagation(); e.preventDefault(); dragging = false; } }, true);
}

// ---------------- Phone sidebar motion ----------------
// Same model as the sheet: a spring from the live position, dragged 1:1 toward its edge to close, decided by
// velocity sign then projected landing. The DOM is rebuilt on every render, so the offset lives here.
let navAnim = null;
let navOffset = 0; // px toward the closed edge; 0 = fully open
const navEl = () => document.querySelector('.sidebar');
const navWidth = () => navEl()?.offsetWidth || 300;
function paintNav(v) {
  navOffset = v;
  const el = navEl();
  if (!el) return;
  // RTL: the sidebar lives on the right, so "closed" is +x.
  el.style.transform = v < 0.5 ? 'none' : `translate3d(${v}px,0,0)`;
  document.querySelector('.scrim')?.style.setProperty('opacity', String(Math.max(0, 1 - v / navWidth())));
}
function openNav() {
  if (!isPhone()) return;
  const from = navAnim && !navAnim.done ? navAnim.stop() : document.body.classList.contains('nav-open') ? navOffset : navWidth();
  document.body.classList.add('nav-open');
  paintNav(from);
  enableNavSwipe();
  navAnim = spring({ from, to: 0, damping: 1, response: 0.32, onUpdate: paintNav });
}
function closeNav(velocity = 0) {
  if (!document.body.classList.contains('nav-open')) return;
  const from = navAnim && !navAnim.done ? navAnim.stop() : navOffset;
  const done = () => { document.body.classList.remove('nav-open'); const el = navEl(); if (el) el.style.transform = ''; navOffset = 0; };
  if (!isPhone()) { done(); return; }
  navAnim = spring({ from, to: navWidth(), velocity, damping: 1, response: 0.3, onUpdate: paintNav, onDone: done });
}
function enableNavSwipe() {
  const el = navEl();
  if (!el || el.dataset.swipe) return;
  el.dataset.swipe = '1';
  const vel = velocityTracker();
  let start = null; let base = 0; let dragging = false;
  const down = (e) => {
    if (e.pointerType !== 'touch') return;
    base = navAnim && !navAnim.done ? navAnim.stop() : navOffset;
    start = { x: e.clientX, y: e.clientY }; dragging = false; vel.reset(); vel.add(e.clientX);
  };
  const move = (e) => {
    if (!start) return;
    vel.add(e.clientX);
    const dx = e.clientX - start.x;
    if (!dragging) {
      if (Math.abs(dx) < 10) return;
      if (Math.abs(e.clientY - start.y) > Math.abs(dx)) { start = null; return; } // vertical: let the list scroll
      dragging = true; e.currentTarget.setPointerCapture(e.pointerId);
    }
    const raw = base + dx;
    paintNav(raw < 0 ? rubberband(raw, navWidth()) : raw);
  };
  const up = () => {
    if (!start) return;
    start = null;
    if (!dragging) return;
    const v = vel.velocity();
    if (v > 450 || (v > -450 && navOffset + project(v, 0.99) > navWidth() / 2)) closeNav(Math.max(v, 0));
    else navAnim = spring({ from: navOffset, to: 0, velocity: v, damping: 1, response: 0.32, onUpdate: paintNav });
  };
  for (const target of [el, document.querySelector('.scrim')]) {
    if (!target) continue;
    target.addEventListener('pointerdown', down);
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
    target.addEventListener('click', (e) => { if (dragging) { e.stopPropagation(); e.preventDefault(); dragging = false; } }, true);
  }
}

function mobileNav() {
  const r = state.route.view;
  const c = counts();
  const item = (n, count) => { const on = navActive(n, r); return h('a', { class: ['mnav', on && 'active'], href: `#/${n.view}`, 'aria-current': on ? 'page' : null }, icon(n.icon, 20), h('span', {}, n.label), count ? h('span', { class: 'mnav-count num neutral', 'aria-label': `${count} פתוחות להיום` }, count) : null); };
  // Tabs only navigate; "new task" is a separate round control beside the bar (HIG: tab bars › Best practices).
  return h('div', { class: 'mobile-dock' },
    // The היום badge means one thing everywhere: work still open today (as in the sidebar).
    h('nav', { class: 'mobile-nav', 'aria-label': 'מסכים' }, navItems().map((n) => item(n, n.view === 'today' ? c.today : n.view === 'shopping' ? shoppingCount() : null))),
    // On the shopping list the + adds an item, not a task.
    r === 'shopping' && state.shopping
      ? h('button', { class: 'dock-add', onclick: () => { const el = document.querySelector('.shopping .qa-input'); el?.focus(); el?.scrollIntoView({ block: 'center' }); }, 'aria-label': 'הוספה לרשימת הקניות' }, icon('plus', 24))
      : h('button', { class: 'dock-add', onclick: () => openPalette('new'), 'aria-label': 'משימה חדשה' }, icon('plus', 24)));
}

// ---------------- Command palette ----------------
function openPalette(mode = 'search') {
  closePalette();
  const input = h('input', { class: 'palette-input', dir: 'auto', placeholder: mode === 'new' ? 'מה המשימה?  #תגית  !חשוב  @מחר  +פרויקט  — Enter ליצירה' : gx`חפש משימה או פקודה…` });
  const list = h('ol', { class: 'palette-list', role: 'listbox' });
  let items = [];
  let index = 0;
  const commands = [
    { label: 'משימה חדשה', icon: 'plus', run: () => openPalette('new') },
    ...navItems().map((n) => ({ label: gx`עבור ל: ${n.label}`, icon: n.icon, run: () => { location.hash = `#/${n.view}`; } })),
    ...state.schema.projects.filter((p) => !p.archived).map((p) => ({ label: `פרויקט: ${p.name}`, icon: 'folder', run: () => { location.hash = `#/project/${p.id}`; } })),
    ...state.schema.views.map((v) => ({ label: `תצוגה: ${v.name}`, icon: 'star', run: () => { location.hash = `#/view/${v.id}`; } })),
    { label: 'בוצעו וארכיון', icon: 'checkCircle', run: () => { location.hash = '#/done'; } },
    { label: 'מבנה והגדרות', icon: 'settings', run: () => { location.hash = '#/settings'; } },
  ];
  const draw = () => {
    const q = input.value.trim();
    if (mode === 'new') {
      const parsed = parseQuick(q);
      items = q ? [{ label: gx`צור: ${parsed.title}`, icon: 'plus', hint: [parsed.when && `📅 ${parsed.when}`, parsed.priority && '⚑', parsed.project && '📁', ...parsed.tags.map((t) => `#${t}`)].filter(Boolean).join(' '), run: async () => { const t = await createTask({ title: parsed.title, tags: parsed.tags, ...(parsed.priority && { priority: parsed.priority }), ...(parsed.when && { when: parsed.when }), ...(parsed.project && { project: parsed.project }) }); if (t) openTask(t.id); } }] : [];
    } else {
      const tasks = q ? sortTasks(allTasks({ archived: true, anySpace: true }).filter((t) => matches(t, {}, q.replace(/^#(\d+)$/, '$1'))), 'updated').slice(0, 8) : sortTasks(allTasks().filter((t) => !isDone(t)), 'updated').slice(0, 5);
      const cmds = commands.filter((c) => !q || c.label.includes(q));
      items = [...cmds.slice(0, q ? 6 : 4), ...tasks.map((t) => ({ label: t.title, icon: isDone(t) ? 'checkCircle' : 'circle', hint: `#${t.id} · ${statusOf(t.status).label}`, run: () => openTask(t.id) }))];
      if (q && !tasks.length) items.push({ label: gx`צור משימה: ${q}`, icon: 'plus', run: async () => { const t = await createTask({ title: q }); if (t) openTask(t.id); } });
    }
    index = Math.min(index, Math.max(items.length - 1, 0));
    list.replaceChildren(...items.map((it, i) => h('li', { class: ['palette-item', i === index && 'on'], role: 'option', onmouseenter: () => { index = i; draw(); }, onclick: () => { closePalette(); it.run(); } }, icon(it.icon, 16), bdi(it.label), it.hint ? h('span', { class: 'palette-hint' }, it.hint) : null)));
  };
  input.addEventListener('input', () => { index = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); index = (index + 1) % Math.max(items.length, 1); draw(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); index = (index - 1 + items.length) % Math.max(items.length, 1); draw(); }
    if (e.key === 'Enter' && !e.isComposing && items[index]) { e.preventDefault(); const it = items[index]; closePalette(); it.run(); }
    if (e.key === 'Escape') closePalette();
  });
  const overlay = h('div', { class: 'palette-overlay', onclick: (e) => { if (e.target === overlay) closePalette(); } },
    h('div', { class: 'palette', role: 'dialog', 'aria-label': 'פקודות' }, h('div', { class: 'palette-head' }, icon(mode === 'new' ? 'plus' : 'search', 18), input), list,
      h('div', { class: 'palette-foot' }, h('span', {}, h('kbd', {}, '↑↓'), ' ניווט'), h('span', {}, h('kbd', {}, 'Enter'), ' בחירה'), h('span', {}, h('kbd', {}, 'Esc'), ' סגירה'))));
  document.body.append(overlay);
  draw();
  input.focus();
}
function closePalette() { document.querySelector('.palette-overlay')?.remove(); }

function showShortcuts() {
  const rows = [['N', 'משימה חדשה'], ['Ctrl K', 'פקודות וחיפוש'], ['/', 'חיפוש'], ['1–4', 'מעבר בין מסכים'], ['Esc', 'סגירת חלון'], ['Enter', 'פתיחת משימה מסומנת'], ['רווח', 'סימון בוצע (במשימה מסומנת)'], ['?', 'החלון הזה']];
  const syntax = [['#תגית', 'הוספת תגית'], ['!', 'עדיפות גבוהה'], ['!!', 'דחוף'], ['@היום / @מחר / @שני / @15.10', 'תאריך עבודה'], ['+שם-פרויקט', 'שיוך לפרויקט']];
  closePalette();
  const overlay = h('div', { class: 'palette-overlay', onclick: (e) => { if (e.target === overlay || e.target.closest('.close')) overlay.remove(); } },
    h('div', { class: 'palette help' }, h('div', { class: 'help-head' }, h('h2', {}, 'קיצורים'), h('button', { class: 'icon-btn close' }, icon('x', 16))),
      h('dl', { class: 'help-grid' }, rows.map(([k, v]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, v)])),
      h('h3', {}, 'תחביר בהוספה מהירה'),
      h('dl', { class: 'help-grid' }, syntax.map(([k, v]) => [h('dt', {}, h('code', { dir: 'auto' }, k)), h('dd', {}, v)]))));
  document.body.append(overlay);
}

// ---------------- Keyboard ----------------
document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea, select, [contenteditable]');
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (e.key === 'Escape') {
    if (document.querySelector('.palette-overlay')) { closePalette(); document.querySelector('.palette-overlay')?.remove(); return; }
    if (state.openTask && !typing) { closeSheet(); return; }
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'n' || e.key === 'מ') { e.preventDefault(); openPalette('new'); }
  else if (e.key === '/' || e.key === '.') { e.preventDefault(); document.querySelector('.search-input')?.focus(); }
  else if (e.key === '?') showShortcuts();
  else if (/^[1-4]$/.test(e.key)) { const n = navItems().find((x) => x.key === e.key); if (n) location.hash = `#/${n.view}`; }
});

// ---------------- Live updates ----------------
// Hermes often edits many tasks in one go: collect its changes for a moment and show ONE toast.
let agentBatch = [];
let agentTimer = null;
function agentToast(event, existed) {
  agentBatch.push({ id: event.task.id, title: event.task.title, summary: existed ? event.activity.summary : 'משימה חדשה', created: !existed, who: actorInfo(event.activity.actor).name });
  clearTimeout(agentTimer);
  agentTimer = setTimeout(() => {
    const batch = agentBatch; agentBatch = [];
    const ids = [...new Set(batch.map((b) => b.id))];
    if (ids.length === 1) {
      const b = batch[batch.length - 1];
      toast(`${b.who}: ${b.summary} — ${b.title}`, { iconName: actorInfo(event.activity.actor).person ? 'user' : 'bot', timeout: 6000, action: { label: gx`פתח`, fn: () => openTask(b.id) } });
    } else {
      const created = new Set(batch.filter((b) => b.created).map((b) => b.id)).size;
      const who = batch[batch.length - 1].who;
      const text = created === ids.length ? `${who}: ${ids.length} משימות חדשות` : created ? `${who}: ${created} חדשות, ${ids.length - created} עודכנו` : `${who} עדכן ${ids.length} משימות`;
      toast(text, { iconName: 'bot', timeout: 8000, action: { label: 'מה השתנה', fn: () => { location.hash = '#/activity'; } } });
    }
  }, 1200);
}
const refreshSchedule = debounce(async () => { try { const { items } = await api.schedule(new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)); setState({ events: items }); writeSnapshot(); } catch { /* offline */ } }, 250);
const refreshShoppingSoon = debounce(() => { if (state.shopping) refreshShopping().then(writeSnapshot); }, 250);
const refreshFeeds = debounce(async () => { await refreshActivity(); refreshDrawerActivity(); setState({}); }, 400);
function onEvent(event) {
  if (event.type === 'hello') { checkVersion(event.version); if (state.schema) resync(); return; }
  if (event.type === 'task') {
    const existed = state.tasks.has(event.task.id);
    putTask(event.task, { revive: event.activity?.action === 'restore' || event.activity?.action === 'create' });
    if (event.activity && event.activity.actor !== state.actor) agentToast(event, existed);
    if (event.activity) refreshFeeds();
  } else if (event.type === 'delete') { dropTask(event.id); refreshFeeds(); }
  else if (event.type === 'activity') refreshFeeds();
  else if (event.type === 'events') refreshSchedule();
  else if (event.type === 'schema') {
    // The server sends no structure over the stream (it differs per person): fetch my view of it.
    (event.schema ? Promise.resolve(event.schema) : api.getSchema()).then((schema) => { setState({ schema }); writeSnapshot(); }).catch(() => {});
    if (event.actor !== state.actor) toast(`${actorInfo(event.actor).name} עדכן את מבנה הלוח`, { iconName: 'bot' });
  } else if (event.type === 'shopping') refreshShoppingSoon();
  else if (event.type === 'notification') {
    resetSettingsCache();
    if (event.ok && event.event_type === 'workboard.reminder') toast(`תזכורת נשלחה לווטסאפ: ${event.title}`, { iconName: 'bell' });
    if (!event.ok) toast(`שליחה לווטסאפ נכשלה: ${event.error}`, { tone: 'error', iconName: 'bell', timeout: 9000 });
  }
}

async function resync() {
  const data = await api.bootstrap();
  replaceTasks(data.tasks);
  setReadOnly(Boolean(data.snapshot_at));
  setLocale(data.locale);
  if (!data.snapshot_at) checkVersion(data.version);
  // A snapshot (served by the service worker when offline) carries the time it was taken.
  setState({ schema: data.schema, degraded: data.degraded, activity: data.activity, events: data.events || [], notifier: data.notifier, device: data.device, offlineSince: data.snapshot_at || null,
    locale: data.locale || null, defaultUser: data.defaultUser || null, me: data.me || null, actor: data.actor || 'dashboard', people: data.people || [], spaces: data.spaces || [], multi: Boolean(data.multi), shopping: data.shopping || null, depts: data.depts || [] });
  if (!data.snapshot_at) writeSnapshot();
}

// ---------------- New version ----------------
// The page keeps running the code it started with. When the server has a newer build: if the app was in the
// background, reload as it comes back (the usual case on the iPhone — nothing is lost); if it's on screen, offer
// "עדכן" instead of yanking the page away mid-typing.
let loadedVersion = null;
let updateOffered = false;
function checkVersion(version) {
  if (!version || version === 'dev') return;
  if (!loadedVersion) { loadedVersion = version; return; }
  if (version === loadedVersion) return;
  if (document.visibilityState === 'hidden') { pendingReload = true; return; }
  offerUpdate();
}
let pendingReload = false;
const applyUpdate = () => { location.reload(); };
function offerUpdate() {
  if (updateOffered) return;
  updateOffered = true;
  document.body.append(h('div', { class: 'update-bar', role: 'status' },
    icon('sparkles', 16), h('span', {}, 'גרסה חדשה של האפליקציה זמינה'),
    h('button', { class: 'btn small primary', onclick: applyUpdate }, 'עדכן')));
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (pendingReload && !document.querySelector('input:focus, textarea:focus')) { applyUpdate(); return; }
  // Back from the background: the live stream may have been asleep, so ask directly.
  try { const { version } = await api.version(); if (loadedVersion && version && version !== loadedVersion && version !== 'dev') applyUpdate(); } catch { /* offline */ }
});

// ---------------- Offline snapshot ----------------
// Only what the server confirmed (never in-flight edits), written after every confirmed change, so the installed
// app opens offline showing the last true state — read-only, with its age on screen.
const SNAPSHOT = 'workboard-snapshot';
const writeSnapshot = debounce(async () => {
  if (!('caches' in window) || state.offlineSince || !state.schema) return;
  const body = { schema: state.schema, degraded: null, tasks: [...confirmed.values()], events: state.events, activity: state.activity.slice(0, 30), notifier: state.notifier, device: state.device, locale: state.locale, me: state.me, actor: state.actor, people: state.people, spaces: state.spaces, multi: state.multi, shopping: state.shopping, depts: state.depts, snapshot_at: new Date().toISOString() };
  try { await (await caches.open(SNAPSHOT)).put('/api/bootstrap', new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })); } catch { /* storage full or unavailable */ }
}, 800);
setConfirmedListener(writeSnapshot);
const clearSnapshot = () => ('caches' in window ? caches.delete(SNAPSHOT).catch(() => {}) : Promise.resolve());

// ---------------- Device pairing ----------------
// Two steps, one thing per screen (accessible-authentication: paste and autofill allowed, no memorised secret):
//  1. who's using this device (only when there are several people) — a tap on your name sends the code;
//  2. the 6-digit code from your WhatsApp, which submits itself when complete, with "send again" and "not you?".
let pairing = false;
function showPairing(status) {
  pairing = true;
  const root = document.querySelector('#app');
  const users = status.users || [];
  const saved = localStorage.getItem('wb-pair-user');
  let who = users.length ? (users.some((u) => u.id === saved) ? saved : null) : null;
  let step = users.length && !who ? 'who' : 'code';
  let sentAt = 0;
  const nameOf = (id) => users.find((u) => u.id === id)?.name || '';
  const msg = h('p', { class: 'pair-msg', role: 'status', 'aria-live': 'polite' });
  const send = async () => {
    msg.textContent = 'שולח…'; msg.className = 'pair-msg';
    try {
      const r = await api.requestCode(who || undefined);
      sentAt = Date.now();
      msg.textContent = r.sent ? '' : 'לא הצלחתי לשלוח לווטסאפ — הקוד נמצא בלוג של השרת (docker logs workboard).';
    } catch (e) { msg.textContent = e.message; msg.className = 'pair-msg danger'; }
    draw();
  };
  const draw = () => {
    if (step === 'who') {
      root.replaceChildren(h('main', { class: 'pair' },
        h('div', { class: 'pair-body' },
          h('img', { src: '/icons/icon-192.png', alt: '', width: 64, height: 64, class: 'pair-icon' }),
          h('h1', {}, gx`מי משתמש/ת במכשיר?`),
          h('p', { class: 'pair-lead' }, gx`נשלח קוד לווטסאפ שלך — כך רק את/ה רואה את המשימות שלך במכשיר הזה.`),
          h('div', { class: 'pair-people', role: 'list' }, users.map((u, i) => h('button', { class: 'pair-person', role: 'listitem', onclick: () => { who = u.id; localStorage.setItem('wb-pair-user', u.id); step = 'code'; send(); } },
            h('span', { class: `pair-avatar av-${i % 4}`, 'aria-hidden': 'true' }, u.name.slice(0, 1)), h('span', { class: 'pair-name' }, u.name), icon('chevron', 16, 'pair-chevron')))),
          !status.canSendCode ? h('p', { class: 'danger small' }, 'שליחת ווטסאפ לא מוגדרת בשרת.') : null)));
      return;
    }
    const code = h('input', { class: 'pair-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, dir: 'ltr', 'aria-label': 'קוד בן 6 ספרות', placeholder: '000000', pattern: '[0-9]*' });
    const verify = async () => {
      const v = code.value.trim();
      if (!/^\d{6}$/.test(v)) { msg.textContent = 'הקוד הוא 6 ספרות'; msg.className = 'pair-msg danger'; return; }
      code.disabled = true;
      try { await api.verifyCode(v, who || undefined); location.reload(); } catch (e) { code.disabled = false; msg.textContent = e.message; msg.className = 'pair-msg danger'; code.select(); }
    };
    code.addEventListener('input', () => { code.value = code.value.replace(/\D/g, '').slice(0, 6); if (code.value.length === 6) verify(); });
    const wait = Math.max(0, 60 - Math.round((Date.now() - sentAt) / 1000));
    const resend = h('button', { class: 'link-btn', disabled: sentAt && wait > 0, onclick: send }, sentAt ? (wait > 0 ? `שליחה חוזרת בעוד ${wait} שנ׳` : gx`שלח קוד שוב`) : gx`שלח לי קוד בווטסאפ`);
    const tick = () => { if (step !== 'code' || !document.body.contains(resend)) return; const left = Math.max(0, 60 - Math.round((Date.now() - sentAt) / 1000)); resend.textContent = left ? `שליחה חוזרת בעוד ${left} שנ׳` : gx`שלח קוד שוב`; resend.disabled = left > 0; if (left) setTimeout(tick, 1000); };
    if (sentAt && wait > 0) setTimeout(tick, 1000);
    root.replaceChildren(h('main', { class: 'pair' },
      users.length ? h('button', { class: 'pair-back link-btn', onclick: () => { step = 'who'; msg.textContent = ''; draw(); } }, icon('chevron', 16, 'flip'), 'החלפה') : null,
      h('div', { class: 'pair-body' },
        h('span', { class: 'pair-wa', 'aria-hidden': 'true' }, icon('chat', 28)),
        h('h1', {}, sentAt ? 'הקוד בדרך' : 'חיבור המכשיר'),
        h('p', { class: 'pair-lead' }, sentAt ? `שלחנו קוד בן 6 ספרות לווטסאפ${who ? ` של ${nameOf(who)}` : ''}. הוא בתוקף 10 דקות.` : 'כל מכשיר מחובר פעם אחת, בקוד שנשלח לווטסאפ שלך.'),
        sentAt ? code : h('button', { class: 'btn primary pair-send', onclick: send }, icon('chat', 18), gx`שלח לי קוד בווטסאפ`),
        msg,
        sentAt ? resend : null,
        !status.canSendCode ? h('p', { class: 'danger small' }, 'שליחת ווטסאפ לא מוגדרת בשרת.') : null)));
    if (sentAt) code.focus();
  };
  draw();
}

// iOS ignores user-scalable=no; its own pinch events can still be cancelled. (Native-app feel: no page zoom.)
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

async function start() {
  // Revoked or logged out: the protected snapshot goes too.
  document.addEventListener('wb:unauthorized', async () => { await clearSnapshot(); if (!pairing) location.reload(); });
  let status;
  // Offline (e.g. the installed app without a connection): skip the check and open from the cached snapshot.
  try { status = await api.authStatus(); } catch { status = { authenticated: true, offline: true }; }
  if (!status.authenticated) { await clearSnapshot(); showPairing(status); return; }
  subscribe(render);
  document.addEventListener('wb:rerender', () => setState({}));
  window.addEventListener('hashchange', onRoute);
  try {
    await resync();
  } catch (error) {
    document.querySelector('#app').replaceChildren(h('div', { class: 'fatal' }, h('h1', {}, 'לא הצלחתי לטעון את Workboard'), h('p', {}, error.message), h('button', { class: 'btn primary', onclick: () => location.reload() }, gx`נסה שוב`)));
    return;
  }
  onRoute();
  // Home-screen shortcut "משימה חדשה" (and ?new=1 links) open the capture palette right away.
  if (new URLSearchParams(location.search).has('new')) { history.replaceState(null, '', `/${location.hash}`); openPalette('new'); }
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  if (parseHash().view === 'task') setState({ route: { view: 'today', param: null, hash: '#/today' } });
  // A dropped live stream may mean this device was revoked: check, and if so wipe what it holds locally.
  // (A device that is already fully offline can't be reached — its snapshot stays until it reconnects.)
  let lastAuthCheck = 0;
  connectEvents(onEvent, async (online) => {
    setState({ online });
    if (online || Date.now() - lastAuthCheck < 15_000) return;
    lastAuthCheck = Date.now();
    try { const s = await api.authStatus(); if (!s.authenticated) { await clearSnapshot(); location.reload(); } } catch { /* offline */ }
  });
  // Re-render every minute so "in 5 minutes" / overdue states stay honest; resync if the day rolled over.
  let day = new Date().toDateString();
  setInterval(() => { if (new Date().toDateString() !== day) { day = new Date().toDateString(); resync(); } else if (!document.querySelector('input:focus, textarea:focus')) setState({}); }, 60_000);
}

start();
