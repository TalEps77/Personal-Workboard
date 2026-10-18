import { saveSchema, setStatus, toast, undoActivity, updateTask } from './actions.js';
import { emptyState, openTask, quickAdd, taskCard, taskRow } from './components.js';
import { currentKind, currentSpace, kindOfSpace, personName, spaceInfo, spaceOf, actorInfo, allTasks, byHorizon, flowStatuses, groupTasks, isDone, isMine, matches, newTaskSpace, orderedStatuses, progress, projectOf, projectsHere, setState, setUi, sortTasks, state, statusOf, todayBuckets, agentName, gx } from './store.js';
import { DAYS, addDays, bdi, daysBetween, dow, h, icon, localDate, localTime, niceDate, relative, today, isWorkday, nextWeekStart, nextWorkday } from './util.js';
import { ganttChart } from './timeline.js';
import { EFFORTS, KINDS, focusList, kindOfTask } from './focus.js';
import { eventsOn, scheduleToday } from './schedule.js';
import { shoppingCard } from './shopping.js';

const COLORS = ['teal', 'blue', 'accent', 'purple', 'pink', 'orange', 'amber', 'green', 'red', 'gray'];

const statusLabel = (category) => state.schema.statuses.find((s) => s.category === category)?.label || category;

function header(title, subtitle, ...actions) {
  return h('header', { class: 'view-head' },
    h('div', {}, h('h1', {}, title), subtitle ? h('p', { class: 'view-sub' }, subtitle) : null),
    h('div', { class: 'view-actions' }, actions));
}

function layoutToggle(key, current, withTimeline = false) {
  const btn = (value, iconName, label) => h('button', { class: ['seg', current === value && 'on'], onclick: () => setUi({ [`layout:${key}`]: value }), title: label, 'aria-pressed': String(current === value) }, icon(iconName, 16), h('span', { class: 'seg-label' }, label));
  const phone = matchMedia('(max-width: 820px)').matches;
  return h('div', { class: 'segmented' }, btn('list', 'list', 'רשימה'), phone ? null : btn('board', 'board', 'לוח'), withTimeline ? btn('timeline', 'calendar', 'ציר זמן') : null);
}

/** Rows with thin date sub-headers (היום / מחר / השבוע…) — the order a list is read in. */
export function withSubheads(tasks, render) {
  const groups = byHorizon(tasks);
  if (groups.length <= 1 && (!groups[0] || groups[0].key === 'none')) return groups.flatMap((g) => g.tasks.map(render));
  return groups.flatMap((g) => [h('div', { class: ['subhead', g.tone && `tone-${g.tone}`], role: 'heading', 'aria-level': '3' }, g.label, h('span', { class: 'num' }, g.tasks.length)), ...g.tasks.map(render)]);
}

function section(title, tasks, { key, collapsible = false, tone, extra, rowOptions, iconName, limit, footer, subheads = false } = {}) {
  if (!tasks.length) return null;
  const collapsed = collapsible && state.ui[`collapsed:${key}`];
  const expanded = state.ui[`expanded:${key}`];
  const shown = limit && !expanded ? tasks.slice(0, limit) : tasks;
  const more = tasks.length - shown.length;
  return h('section', { class: ['group', tone && `tone-${tone}`], id: key ? `sec-${key}` : null },
    h('div', { class: 'group-head' },
      h('button', { class: 'group-title', disabled: !collapsible, onclick: () => collapsible && setUi({ [`collapsed:${key}`]: !collapsed }) },
        collapsible ? icon(collapsed ? 'chevron' : 'chevronDown', 14, 'twist') : null,
        iconName ? icon(iconName, 15) : null,
        h('span', {}, title), h('span', { class: 'count num' }, tasks.length)),
      extra || null),
    collapsed ? null : h('div', { class: 'rows', role: 'list' }, subheads ? withSubheads(shown, (t) => taskRow(t, rowOptions)) : shown.map((t) => taskRow(t, rowOptions)),
      // "More" and "less" are different actions, so they must not look alike (HIG: color: one color, one meaning).
      more > 0 ? h('button', { class: 'row-more', onclick: () => setUi({ [`expanded:${key}`]: true }) }, icon('chevronDown', 16), gx`הצג עוד ${more}`) : null,
      limit && expanded && tasks.length > limit ? h('button', { class: 'row-more less', onclick: () => { setUi({ [`expanded:${key}`]: false }); document.getElementById(`sec-${key}`)?.scrollIntoView({ block: 'nearest' }); } }, icon('chevronDown', 16, 'flip'), gx`הצג פחות`) : null),
    collapsed ? null : footer || null);
}

// ---------------- Today ----------------
function greeting() {
  const hour = Number(localTime(new Date()).slice(0, 2));
  if (hour < 5) return 'לילה טוב';
  if (hour < 12) return 'בוקר טוב';
  if (hour < 17) return 'צהריים טובים';
  if (hour < 21) return 'ערב טוב';
  return 'לילה טוב';
}

function ring(done, total) {
  const pct = total ? done / total : 0;
  const r = 26; const c = 2 * Math.PI * r;
  return h('div', { class: 'ring' },
    h('svg', { width: 64, height: 64, viewBox: '0 0 64 64' },
      h('circle', { cx: 32, cy: 32, r, class: 'ring-track' }),
      pct > 0 ? h('circle', { cx: 32, cy: 32, r, class: 'ring-fill', 'stroke-dasharray': `${c * pct} ${c}`, transform: 'rotate(-90 32 32)' }) : null),
    h('span', { class: 'ring-label num' }, total ? `${Math.round(pct * 100)}%` : '—'));
}

export function activityFeed(items, { limit = 12, title = 'פעילות אחרונה' } = {}) {
  const actorIcon = (a) => actorInfo(a).icon;
  const actorName = (a) => actorInfo(a).name;
  return h('section', { class: ['panel', !items.length && 'is-empty'] },
    h('h2', { class: 'panel-title' }, icon('zap', 15), title, items.length ? h('a', { class: 'link-btn panel-more', href: '#/activity' }, 'הכל') : null),
    items.length ? h('ol', { class: 'feed' }, items.slice(0, limit).map((a) => h('li', { class: ['feed-item', actorInfo(a.actor).agent && 'by-agent'] },
      h('span', { class: 'feed-icon' }, icon(actorIcon(a.actor), 14)),
      h('div', { class: 'feed-body' },
        h('div', {}, h('strong', {}, actorName(a.actor)), ' · ', h('a', { href: a.task ? `#/task/${a.task}` : '#/settings', class: 'feed-link' }, bdi(a.title || `#${a.task}`))),
        h('div', { class: 'feed-meta' }, a.summary, ' · ', relative(a.at))),
      a.undoable ? h('button', { class: 'icon-btn small', title: gx`בטל פעולה זו`, onclick: () => undoActivity(a) }, icon('undo', 14)) : null)))
      : h('p', { class: 'muted small' }, 'עוד אין פעילות.'));
}

function remindersPanel(list) {
  return h('section', { class: ['panel', !list.length && 'is-empty'] },
    h('h2', { class: 'panel-title' }, icon('bell', 15), 'תזכורות היום'),
    list.length ? h('ol', { class: 'timeline' }, list.map(({ task, reminder }) => h('li', { class: ['tl-item', Date.parse(reminder.at) < Date.now() && 'past', reminder.last_error && 'failed'], onclick: () => openTask(task.id) },
      h('span', { class: 'tl-time num', dir: 'ltr' }, localTime(reminder.at)),
      h('div', {}, h('div', { class: 'tl-title' }, bdi(task.title)), reminder.note ? h('div', { class: 'muted small' }, bdi(reminder.note)) : null,
        reminder.last_error ? h('div', { class: 'danger small' }, 'השליחה נכשלה — ננסה שוב') : null))))
      : h('p', { class: 'muted small' }, `אין תזכורות להיום. אפשר לבקש מ־${agentName()}: ״תזכיר לי מחר ב־9 על…״`));
}

/** היום has two modes: the day (default) and "זמן פנוי" — what to work on alone when there's a gap. */
function todayModes(mode) {
  const seg = (value, label, iconName, hash) => h('a', { class: ['seg', mode === value && 'on'], href: hash, 'aria-current': mode === value ? 'page' : null }, icon(iconName, 16), h('span', { class: 'seg-label' }, label));
  return h('div', { class: 'segmented today-modes' }, seg('day', 'היום שלי', 'sun', '#/today'), seg('focus', 'יש לי זמן פנוי', 'target', '#/focus'));
}

export function todayView({ mode = 'day' } = {}) {
  if (mode === 'focus') {
    const t0 = today(); const [, m0, d0] = t0.split('-').map(Number);
    return h('div', { class: 'today today-focus' }, h('div', { class: 'today-main' },
      h('header', { class: 'large-title' }, h('p', { class: 'eyebrow' }, `יום ${DAYS[dow(t0)]} · ${d0}.${m0}`), h('h1', {}, 'זמן פנוי')),
      todayModes('focus'),
      ...focusBody()));
  }
  const b = todayBuckets();
  const t = today();
  const [, m, d] = t.split('-').map(Number);
  // The context shapes the day: work keeps the work-week rhythm (weekends off, closing the day, free-time mode);
  // personal and home run all week; home shows who's on what and the shopping list.
  const kind = state.multi ? currentKind() : 'work';
  const workish = kind === 'work' || kind === 'all';
  const ctxName = state.multi ? (kind === 'all' ? 'הכל' : spaceInfo(currentSpace())?.label) : null;
  const remaining = b.overdue.length + b.planned.length + b.carried.length + b.active.length;
  const totalToday = remaining + b.doneToday.length;
  const months = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  // On a day off (Fri/Sat) or a day with nothing planned, look ahead to the next workday instead of showing a backlog.
  const offDay = workish && !isWorkday(t);
  let ahead = addDays(t, 1);
  while (!isWorkday(ahead)) ahead = addDays(ahead, 1);
  const aheadTasks = sortTasks(b.open.filter((x) => (x.when === ahead || x.deadline === ahead) && !b.overdue.includes(x)));
  const lookAhead = (offDay || b.planned.length === 0) && aheadTasks.length > 0;
  const aheadName = daysBetween(t, ahead) === 1 ? 'מחר' : `ביום ${DAYS[dow(ahead)]}`;

  // Signature: the "today stack" — the app icon's stack of task cards, made of real data. The front card is the
  // day (progress + what's next); the cards peeking beneath it stand for what's still queued.
  // "What next" has one answer across the app: the same ranking as the free-time page, over today's work.
  const rankedToday = focusList([...b.overdue, ...b.planned, ...b.carried, ...b.active], state.schema, t, { kinds: null });
  const next = rankedToday[0]?.task || (lookAhead ? aheadTasks[0] : null) || b.nextUp[0] || null;
  const nextWhy = rankedToday[0]?.why.slice(0, 2).join(' · ');
  const queued = remaining - (next ? 1 : 0);
  const card = h('section', { class: ['day-stack', queued > 0 && 'peek-1', queued > 1 && 'peek-2'], 'aria-label': 'היום' },
    h('div', { class: 'day-card' },
      h('div', { class: 'day-top' },
        h('div', {},
          h('div', { class: 'day-label' }, offDay ? (dow(t) === 6 ? 'שבת שלום' : 'סוף שבוע') : 'היום'),
          h('div', { class: 'day-count' },
            totalToday ? h('span', {}, h('strong', { class: 'num' }, b.doneToday.length), ` מתוך ${totalToday} בוצעו`)
              : lookAhead ? h('span', {}, `${aheadName}: `, h('strong', { class: 'num' }, aheadTasks.length), ' משימות')
                : offDay ? 'אין משימות לסוף השבוע' : 'אין משימות מתוכננות')),
        totalToday ? ring(b.doneToday.length, totalToday) : null),
      next
        ? h('button', { class: 'day-next', onclick: () => openTask(next.id) }, h('span', { class: 'day-next-label' }, b.overdue.includes(next) ? 'באיחור' : lookAhead && aheadTasks[0] === next ? aheadName : 'הבא'), h('span', { class: 'day-next-text' }, bdi(next.title), nextWhy && rankedToday[0]?.task === next ? h('span', { class: 'day-next-why' }, nextWhy) : null), icon('chevron', 16, 'day-next-chevron'))
        : h('div', { class: 'day-next quiet' }, b.doneToday.length ? 'סגרת את כל מה שתוכנן להיום' : 'השולחן נקי — מה הכי חשוב לקדם?')));
  const top = (list, n) => list.slice(0, n);
  const main = h('div', { class: 'today-main' },
    h('header', { class: 'large-title' }, h('p', { class: 'eyebrow' }, `${ctxName ? `${ctxName} · ` : ''}יום ${DAYS[dow(t)]} · ${d} ב${months[m - 1]}`), h('h1', {}, `${greeting()}${state.me?.name ? `, ${state.me.name}` : ''}`)),
    workish ? todayModes('day') : null,
    card,
    kind === 'home' || kind === 'personal' ? shoppingCard() : null,
    // Outside work an empty schedule is just noise: show it only when something is booked.
    workish || eventsOn(t).length ? scheduleToday() : null,
    workish ? closeDay(b, t, offDay) : null,
    quickAdd({ defaults: { when: t }, key: 'today', placeholder: kind === 'home' ? 'משימה לבית…' : kind === 'personal' ? 'משימה אישית…' : matchMedia('(max-width: 820px)').matches ? 'משימה חדשה להיום…' : 'מה עוד צריך לקרות היום?  (#תגית  !חשוב  +פרויקט)' }),
    // A live view, not a sorting bank: Hermes files tasks itself; only what it couldn't place shows as unsorted.
    b.unsorted.length ? section(statusLabel('inbox'), b.unsorted, { key: 'unsorted', iconName: 'inbox', tone: 'accent', rowOptions: { triage: true, showStatus: false }, limit: 3, footer: h('p', { class: 'swipe-hint muted small' }, gx`${agentName()} לא היה בטוח איפה לשים — החלק ימינה כדי לקבוע סטטוס, או ענה לו בווטסאפ`) }) : null,
    section('באיחור', b.overdue, { key: 'overdue', collapsible: true, tone: 'danger', iconName: 'flag' }),
    section('להיום', b.planned, { key: 'planned', iconName: 'sun' }),
    b.carried.length ? section('נגרר מימים קודמים', b.carried, { key: 'carried', iconName: 'calendar', collapsible: true, limit: 5 }) : null,
    b.followups.length ? section('מעקב היום', b.followups, { key: 'followups', iconName: 'pause', collapsible: true, rowOptions: { showStatus: false } }) : null,
    b.activeGroups.map((g) => section(g.status.label, g.tasks, { key: `active-${g.status.id}`, iconName: g.status.id === 'waiting' ? 'pause' : 'zap', collapsible: true, limit: 6, rowOptions: { showStatus: false } })),
    lookAhead ? section(`${aheadName} · ${Number(ahead.slice(8))}.${Number(ahead.slice(5, 7))}`, aheadTasks, { key: 'ahead', iconName: 'calendar', limit: 6 }) : null,
    // Not the whole backlog: the three things most worth moving, then a link to the rest.
    b.nextUp.length ? section('כדאי לקדם', top(b.nextUp.filter((x) => !aheadTasks.includes(x)), 3), { key: 'nextUp', iconName: 'star', rowOptions: { showStatus: false },
      extra: h('a', { class: 'link-btn', href: '#/board' }, `כל ${statusLabel('todo')} (${b.nextUp.length})`) }) : null,
    kind === 'home' ? homeOthers() : null,
    !b.open.length ? emptyState('אין משימות פתוחות', gx`שלח ל־${agentName()} בווטסאפ מה צריך לקרות, או הוסף כאן.`, 'sun') : null,
    b.doneToday.length ? section('בוצעו היום', b.doneToday, { key: 'doneToday', collapsible: true, tone: 'success', iconName: 'checkCircle' }) : null);

  const aside = h('aside', { class: 'today-aside' }, remindersPanel(b.reminders), activityFeed(state.activity, { limit: 8 }));
  return h('div', { class: 'today' }, main, aside);
}

// At home: what's on the other person (or on nobody) — so you can see the whole house, not only your part.
function homeOthers() {
  const open = allTasks().filter((x) => !isDone(x) && kindOfSpace(x) === 'home');
  const others = state.people.filter((p) => p.id !== state.me?.id);
  return [
    ...others.map((p) => section(`על ${p.name}`, sortTasks(open.filter((x) => x.assignee === p.id)), { key: `home-on-${p.id}`, iconName: 'user', collapsible: true, limit: 4, subheads: false })),
  ];
}

// End of the workday: what's still open from today, each one closed in a tap — or all moved on with one undo.
function closeDay(b, t, offDay) {
  const hour = Number(localTime(new Date()).slice(0, 2));
  const left = [...b.overdue, ...b.planned, ...b.carried].filter((x) => !isDone(x));
  if (offDay || hour < 17 || !left.length) return null;
  const next = nextWorkday(t);
  const week = nextWeekStart(t);
  const nextName = daysBetween(t, next) === 1 ? 'מחר' : `יום ${DAYS[dow(next)]}`;
  // Closing the day decides "this happens on day X": a deadline that is today or already passed moves with it —
  // otherwise the task stays "overdue" and never leaves this list. Undo restores both.
  const changesFor = (task, when) => ({ when, seen: true, ...(task.deadline && task.deadline <= t && { deadline: when }) });
  const move = async (task, when, label) => {
    const before = { when: task.when, deadline: task.deadline };
    const changes = changesFor(task, when);
    if (!(await updateTask(task.id, changes))) return;
    toast(`${task.title} → ${label}${changes.deadline ? ' (כולל הדדליין)' : ''}`, { iconName: 'calendar', action: { label: 'ביטול', fn: () => updateTask(task.id, before) } });
  };
  const moveAll = async () => {
    const before = left.map((x) => [x.id, { when: x.when, deadline: x.deadline }]);
    await Promise.all(left.map((x) => updateTask(x.id, changesFor(x, next))));
    toast(`${left.length} משימות הועברו ל${nextName}`, { iconName: 'calendar', action: { label: 'ביטול', fn: () => before.forEach(([id, b]) => updateTask(id, b)) } });
  };
  return h('section', { class: 'close-day', 'aria-label': 'סגירת יום' },
    h('div', { class: 'close-day-head' },
      h('div', {}, h('h2', {}, 'סגירת יום'), h('p', { class: 'muted small' }, `${left.length} נשארו פתוחות מהיום — מה עושים איתן?`)),
      h('button', { class: 'btn small', onclick: moveAll }, `הכל ל${nextName}`)),
    h('div', { class: 'close-day-list', role: 'list' }, (state.ui.closeDayAll ? left : left.slice(0, 3)).map((x) => h('div', { class: 'close-day-row', role: 'listitem' },
      h('button', { class: 'close-day-title', onclick: () => openTask(x.id) }, bdi(x.title), x.deadline && x.deadline <= t ? h('span', { class: 'danger small' }, ` · עד ${niceDate(x.deadline)}`) : null),
      h('div', { class: 'close-day-actions' },
        h('button', { class: 'mini', onclick: () => setStatus(x, state.schema.statuses.find((s) => s.category === 'done')?.id) }, icon('check', 14), 'בוצע'),
        h('button', { class: 'mini', onclick: () => move(x, next, nextName) }, nextName),
        h('button', { class: 'mini', onclick: () => move(x, week, 'שבוע הבא') }, 'שבוע הבא')))),
      left.length > 3 ? h('button', { class: 'row-more', onclick: () => setUi({ closeDayAll: !state.ui.closeDayAll }) }, icon('chevronDown', 16, state.ui.closeDayAll ? 'flip' : null), state.ui.closeDayAll ? gx`הצג פחות` : `עוד ${left.length - 3}`) : null));
}

// ---------------- Generic list / board ----------------
export function listView({ key, title, subtitle, hint, filter = {}, sort = 'date', group = 'none', layout = 'list', defaults = {}, showQuickAdd = true, emptyTitle = 'אין כאן משימות', emptyText = '', rowOptions, groupable = false, forceLayout = null } = {}) {
  // On the phone the board is not a layout: grouping by status gives the same view, with swipes (no HTML5 drag).
  const phone = matchMedia('(max-width: 820px)').matches;
  const current = phone ? 'list' : forceLayout || state.ui[`layout:${key}`] || layout;
  if (groupable) group = state.ui[`group:${key}`] || group;
  if (group === 'status') rowOptions = { ...rowOptions, showStatus: false };
  if (filter.project?.length === 1) rowOptions = { ...rowOptions, showProject: false };
  const tasks = allTasks().filter((t) => matches(t, filter, state.search));
  const visible = tasks;
  const body = current === 'board' ? boardView(visible, defaults, key) : (() => {
    const groups = groupTasks(sortTasks(visible.filter((t) => !isDone(t) || filter.category || filter.status), sort), group);
    const subheads = group !== 'when' && sort === 'date';
    const doneOnes = filter.category || filter.status ? [] : sortTasks(visible.filter(isDone), 'updated').slice(0, 15);
    if (!groups.some((g) => g.tasks.length) && !doneOnes.length) return emptyState(emptyTitle, emptyText, 'inbox');
    return h('div', {},
      groups.map((g) => (g.label ? section(g.label, g.tasks, { key: `${key}:${g.key}`, collapsible: true, rowOptions, tone: g.tone, subheads, ...(g.key === 'someday' && { collapsible: true }) }) : h('div', { class: 'rows', role: 'list' }, subheads ? withSubheads(g.tasks, (t) => taskRow(t, rowOptions)) : g.tasks.map((t) => taskRow(t, rowOptions))))),
      doneOnes.length ? section('בוצעו לאחרונה', doneOnes, { key: `${key}:done`, collapsible: true, tone: 'success', rowOptions }) : null);
  })();
  return h('div', { class: ['view', current === 'board' && 'wide'] },
    header(title, subtitle || `${tasks.filter((t) => !isDone(t)).length} פתוחות`,
      groupable && current === 'list' ? h('div', { class: 'segmented' }, [['when', 'תאריך'], ['status', 'סטטוס'], ['project', 'פרויקט'], ['with', 'אנשים']].map(([g, label]) => h('button', { class: ['seg', group === g && 'on'], onclick: () => setUi({ [`group:${key}`]: g }) }, label))) : null,
      phone ? null : layoutToggle(key, current)),
    hint ? h('p', { class: 'swipe-hint muted small', style: { margin: '-6px 4px 12px' } }, hint) : null,
    showQuickAdd ? quickAdd({ defaults, key: `list-${key}` }) : null,
    body);
}

// On a phone the board's columns become a status picker over a swipeable list: HTML5 drag doesn't work with
// touch, and a 86vw column showed one status at a time anyway.
function phoneBoard(tasks, key) {
  const statuses = flowStatuses().filter((s) => s.category !== 'done' && (s.category !== 'inbox' || tasks.some((t) => t.status === s.id)));
  const current = statuses.find((s) => s.id === state.ui[`boardTab:${key}`]) || statuses.find((s) => tasks.some((t) => t.status === s.id && s.category === 'active')) || statuses[0];
  const list = tasks.filter((t) => t.status === current.id);
  return h('div', {},
    h('div', { class: 'status-tabs', role: 'tablist' }, statuses.map((s) => {
      const n = tasks.filter((t) => t.status === s.id).length;
      return h('button', { class: ['status-tab', `c-${s.color}`, s.id === current.id && 'on'], role: 'tab', 'aria-selected': String(s.id === current.id), onclick: () => setUi({ [`boardTab:${key}`]: s.id }) }, h('span', { class: 'dot' }), s.label, h('span', { class: 'num status-tab-count' }, n));
    })),
    list.length ? h('div', { class: 'rows', role: 'list' }, withSubheads(list, (t) => taskRow(t, { showStatus: false }))) : emptyState(`אין כרגע משימות ב״${current.label}״`, gx`החלק משימה ימינה ברשימה אחרת כדי להעביר לכאן.`, 'board'),
    h('p', { class: 'swipe-hint muted small' }, gx`החלק שורה שמאלה כדי להזיז תאריך, ימינה כדי לשנות סטטוס`));
}

export function boardView(tasks, defaults = {}, key = 'board') {
  if (matchMedia('(max-width: 820px)').matches) return phoneBoard(tasks.filter((t) => !t.archived), key);
  const known = new Set(state.schema.statuses.map((s) => s.id));
  const orphans = [...new Set(tasks.map((t) => t.status).filter((id) => !known.has(id)))].map((id) => statusOf(id));
  // The unsorted column only appears when something is actually unsorted (and then at the end).
  const statuses = [...flowStatuses().filter((s) => !(state.ui.hideLater && s.category === 'later') && !(s.category === 'inbox' && !tasks.some((t) => t.status === s.id))), ...orphans];
  const columns = statuses.map((s) => {
    let items = sortTasks(tasks.filter((t) => t.status === s.id), 'date');
    const total = items.length;
    if (s.category === 'done') items = sortTasks(items, 'updated').slice(0, 12);
    const col = h('section', { class: `column c-${s.color}`, dataset: { status: s.id } },
      h('header', { class: 'column-head' }, h('span', { class: 'dot' }), h('span', { class: 'column-title' }, s.label), h('span', { class: 'count num' }, total),
        h('button', { class: 'icon-btn small', title: gx`הוסף ל״${s.label}״`, onclick: (e) => { const qa = e.currentTarget.closest('.column').querySelector('.column-add'); qa.classList.toggle('show'); qa.querySelector('input')?.focus(); } }, icon('plus', 14))),
      h('div', { class: 'column-add' }, quickAdd({ defaults: { ...defaults, status: s.id }, placeholder: 'משימה חדשה…', key: `col-${s.id}` })),
      h('div', { class: 'column-body' }, s.category === 'done' ? items.map(taskCard) : withSubheads(items, taskCard), !items.length ? h('div', { class: 'column-empty' }, gx`גרור לכאן משימה כדי להעביר אותה לסטטוס הזה`) : null,
        s.category === 'done' && total > items.length ? h('a', { class: 'column-more', href: '#/done' }, `עוד ${total - items.length} ב״בוצעו״`) : null));
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); });
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      const id = e.dataTransfer.getData('text/plain');
      const task = state.tasks.get(id);
      if (!task) return;
            // Columns are ordered by date, so a drop only changes the status (no hidden manual order to fight with).
      if (task.status !== s.id) setStatus(task, s.id);
    });
    return col;
  });
  const board = h('div', { class: 'board' }, columns);
  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.dataTransfer.setData('text/plain', card.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => card.classList.add('dragging'));
  });
  board.addEventListener('dragend', (e) => e.target.closest?.('.card')?.classList.remove('dragging'));
  return board;
}

// ---------------- Projects ----------------
export function projectsView() {
  const t = today();
  const projects = projectsHere().filter((p) => !p.archived || state.ui.showArchivedProjects);
  const all = allTasks();
  const input = h('input', { placeholder: 'שם הפרויקט החדש…', dir: 'auto', dataset: { key: 'new-project' } });
  const add = async () => {
    const name = input.value.trim();
    if (!name) return;
    const id = `p${Date.now().toString(36).slice(-5)}`;
    const color = COLORS[state.schema.projects.length % COLORS.length];
    const space = newTaskSpace();
    const saved = await saveSchema((x) => { x.projects.push({ id, name, color, archived: false, ...(space && space !== 'work' && { space }) }); }, `פרויקט ״${name}״ נוצר`);
    if (saved) input.value = '';
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  // A compact list, soonest-due first (a grid of big cards showed ~1.5 projects per phone screen).
  const info = projects.map((p) => {
    const tasks = all.filter((x) => x.project === p.id);
    const open = tasks.filter((x) => !isDone(x));
    const dates = [p.due, ...(p.milestones || []).filter((m) => !m.done).map((m) => m.date), ...open.map((x) => x.deadline)].filter(Boolean).sort();
    const nextTask = sortTasks(open, 'deadline')[0];
    return { p, tasks, open, nextDate: dates[0] || null, nextTask };
  }).sort((a, b) => (a.nextDate || '9').localeCompare(b.nextDate || '9') || b.open.length - a.open.length);
  const loose = all.filter((x) => !isDone(x) && !projectOf(x.project));
  const row = ({ p, tasks, open, nextDate, nextTask }) => {
    const pct = tasks.length ? Math.round(((tasks.length - open.length) / tasks.length) * 100) : 0;
    const nextMs = (p.milestones || []).find((m) => !m.done && m.date);
    return h('a', { class: `project-row c-${p.color}`, href: `#/project/${p.id}` },
      h('span', { class: 'project-ring', style: { '--pct': pct } }),
      h('div', { class: 'project-main' },
        h('div', { class: 'project-name' }, bdi(p.name), p.archived ? h('span', { class: 'pill' }, 'בארכיון') : null),
        p.goal ? h('div', { class: 'project-goal' }, bdi(p.goal)) : nextTask ? h('div', { class: 'project-goal muted' }, bdi(nextTask.title)) : null,
        h('div', { class: 'row-meta' },
          h('span', { class: 'meta-item' }, h('span', { class: 'num' }, open.length), ' פתוחות'),
          nextMs ? h('span', { class: 'meta-item' }, h('span', { class: 'g-diamond' }), `${nextMs.title} · ${niceDate(nextMs.date)}`) : null,
          p.due ? h('span', { class: ['meta-item', p.due < t && 'is-danger'] }, icon('flag', 13), `יעד ${niceDate(p.due)}`) : !nextMs && nextDate ? h('span', { class: ['meta-item', nextDate < t && 'is-danger'] }, icon('flag', 13), niceDate(nextDate)) : null)),
      icon('chevron', 16, 'project-chevron'));
  };
  return h('div', { class: 'view' },
    header('פרויקטים', `${projects.length} פרויקטים${loose.length ? ` · ${loose.length} משימות בלי פרויקט` : ''}`),
    h('div', { class: 'rows' }, info.map(row),
      loose.length ? h('a', { class: 'project-row c-gray', href: '#/all' }, h('span', { class: 'project-ring', style: { '--pct': 0 } }),
        h('div', { class: 'project-main' }, h('div', { class: 'project-name' }, 'ללא פרויקט'), h('div', { class: 'project-goal muted' }, loose.slice(0, 3).map((x) => x.title).join(' · '))),
        h('span', { class: 'num muted' }, loose.length)) : null),
    h('div', { class: 'project-new' }, icon('plus', 16), input, h('button', { class: 'btn primary small', onclick: add }, gx`צור פרויקט`)));
}

function goalCard(p) {
  const t = today();
  const all = allTasks().filter((x) => x.project === p.id);
  const done = all.filter(isDone).length;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;
  const update = (fn, msg) => saveSchema((x) => { x.projects = x.projects.map((pr) => (pr.id === p.id ? fn({ ...pr, milestones: [...(pr.milestones || [])] }) : pr)); }, msg);
  const daysLeft = p.due ? daysBetween(t, p.due) : null;
  const goal = h('input', { class: 'goal-input', value: p.goal || '', dir: 'auto', placeholder: 'מה היעד של הפרויקט? (למשל: דשבורד לקוחות באוויר)', dataset: { key: `goal-${p.id}` }, onchange: (e) => update((pr) => ({ ...pr, goal: e.target.value.trim() }), 'היעד עודכן') });
  const due = h('input', { type: 'date', class: 'date-input', value: p.due || '', dataset: { key: `due-${p.id}` }, onchange: (e) => update((pr) => ({ ...pr, due: e.target.value || null }), 'תאריך היעד עודכן') });
  const mTitle = h('input', { class: 'input', placeholder: 'אבן דרך חדשה…', dir: 'auto', dataset: { key: `ms-title-${p.id}` } });
  const mDate = h('input', { type: 'date', class: 'date-input', dataset: { key: `ms-date-${p.id}` } });
  const addMs = () => { if (!mTitle.value.trim()) { mTitle.focus(); return; } update((pr) => ({ ...pr, milestones: [...pr.milestones, { title: mTitle.value.trim(), date: mDate.value || null, done: false }] }), 'אבן הדרך נוספה'); };
  mTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') addMs(); });
  return h('section', { class: `goal-card c-${p.color}` },
    h('div', { class: 'goal-top' }, icon('star', 18), goal),
    h('div', { class: 'goal-meta' },
      h('label', { class: 'goal-due' }, icon('flag', 14), 'יעד עד', due),
      daysLeft !== null ? h('span', { class: ['pill', daysLeft < 0 ? 'c-red' : daysLeft <= 7 ? 'c-amber' : 'c-gray'] }, daysLeft < 0 ? `באיחור ${-daysLeft} ימים` : daysLeft === 0 ? 'היום' : `עוד ${daysLeft} ימים`) : null,
      h('span', { class: 'goal-progress' }, h('span', { class: 'progress-track' }, h('span', { class: 'progress-fill', style: { inlineSize: `${pct}%` } })), h('span', { class: 'progress-label num' }, `${done}/${all.length} משימות`))),
    h('ol', { class: 'milestones' }, (p.milestones || []).map((m) => h('li', { class: ['milestone', m.done && 'done', !m.done && m.date && m.date < t && 'late'] },
      h('label', { class: 'step-check' }, h('input', { type: 'checkbox', checked: m.done, onchange: (e) => update((pr) => ({ ...pr, milestones: pr.milestones.map((x) => (x.id === m.id ? { ...x, done: e.target.checked } : x)) }), e.target.checked ? 'אבן הדרך הושלמה' : 'אבן הדרך נפתחה מחדש') }), h('span', { class: 'box' }, icon('check', 12))),
      h('span', { class: 'g-diamond' }),
      h('span', { class: 'milestone-title' }, bdi(m.title)),
      h('span', { class: 'milestone-date num' }, m.date ? niceDate(m.date) : 'ללא תאריך'),
      h('button', { class: 'icon-btn small', title: gx`מחק אבן דרך`, onclick: () => update((pr) => ({ ...pr, milestones: pr.milestones.filter((x) => x.id !== m.id) }), 'אבן הדרך נמחקה') }, icon('x', 13))))),
    h('div', { class: 'milestone-new' }, mTitle, mDate, h('button', { class: 'btn small', onclick: addMs }, icon('plus', 14), gx`הוסף`)));
}

export function projectView(id) {
  const p = projectOf(id);
  if (!p) return emptyState('הפרויקט לא נמצא', null, 'folder');
  const rename = h('input', { class: 'title-input', value: p.name, dir: 'auto', dataset: { key: `proj-name-${id}` },
    onchange: (e) => { const name = e.target.value.trim(); if (name && name !== p.name) saveSchema((x) => { x.projects = x.projects.map((pr) => (pr.id === id ? { ...pr, name } : pr)); }, 'שם הפרויקט עודכן'); } });
  const colorPick = h('details', { class: 'color-pop', dataset: { key: `proj-color-${id}` } },
    h('summary', { title: 'צבע הפרויקט' }, h('span', { class: `swatch c-${p.color} on` }), 'צבע'),
    h('div', { class: 'swatches pop' }, COLORS.map((c) => h('button', { class: ['swatch', `c-${c}`, p.color === c && 'on'], title: c, onclick: (e) => { e.currentTarget.closest('details').open = false; saveSchema((x) => { x.projects = x.projects.map((pr) => (pr.id === id ? { ...pr, color: c } : pr)); }, 'הצבע עודכן'); } }))));
  const key = `project:${id}`;
  const layout = state.ui[`layout:${key}`] || 'list';
  const view = layout === 'timeline'
    ? h('div', { class: 'view wide' }, header('', ''), ganttChart(allTasks().filter((x) => x.project === id && !isDone(x)), [p]))
    : listView({ key, title: '', filter: { project: [id] }, group: 'when', defaults: { project: id }, rowOptions: { showProject: false } });
  view.querySelector('.view-head h1').replaceWith(h('div', { class: `project-title c-${p.color}` }, h('span', { class: 'dot big' }), rename));
  const actions = view.querySelector('.view-actions');
  actions.replaceChildren(colorPick,
    h('button', { class: 'btn ghost small', onclick: () => saveSchema((x) => { x.projects = x.projects.map((pr) => (pr.id === id ? { ...pr, archived: !pr.archived } : pr)); }, p.archived ? 'הפרויקט הוחזר' : 'הפרויקט הועבר לארכיון') }, icon('archive', 14), p.archived ? gx`החזר` : 'ארכיון'),
    layoutToggle(key, layout, true));
  view.querySelector('.view-head').after(goalCard(p));
  return view;
}

// ---------------- Done / archive ----------------
export function doneView() {
  const showArchived = state.ui.doneShowArchived;
  const items = allTasks({ archived: true }).filter((x) => (showArchived ? x.archived : isDone(x) && !x.archived) && matches(x, {}, state.search));
  const byDay = new Map();
  for (const x of sortTasks(items, 'updated')) {
    const day = x.completed_at ? localDate(x.completed_at) : localDate(x.updated_at);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(x);
  }
  const toggle = h('div', { class: 'segmented' },
    h('button', { class: ['seg', !showArchived && 'on'], onclick: () => setUi({ doneShowArchived: false }) }, icon('checkCircle', 15), h('span', { class: 'seg-label' }, 'בוצעו')),
    h('button', { class: ['seg', showArchived && 'on'], onclick: () => setUi({ doneShowArchived: true }) }, icon('archive', 15), h('span', { class: 'seg-label' }, 'ארכיון')));
  return h('div', { class: 'view' },
    header(showArchived ? 'ארכיון' : 'בוצעו', `${items.length} משימות`, toggle),
    items.length ? [...byDay.entries()].map(([day, list]) => section(niceDate(day), list, { key: `done:${day}`, collapsible: true, rowOptions: { showStatus: false } }))
      : emptyState(showArchived ? 'הארכיון ריק' : 'עוד לא הושלמו משימות', null, 'checkCircle'));
}

// ---------------- Search results ----------------
export function searchView() {
  const results = allTasks({ archived: true, anySpace: true }).filter((x) => matches(x, {}, state.search));
  const open = results.filter((x) => !isDone(x));
  const done = sortTasks(results.filter(isDone), 'updated');
  return h('div', { class: 'view' },
    header(`חיפוש: ״${state.search}״`, `${open.length} פתוחות${done.length ? ` · ${done.length} שבוצעו` : ''}`,
      h('button', { class: 'btn small', onclick: () => setState({ search: '' }) }, icon('x', 14), 'נקה חיפוש')),
    open.length ? h('div', { class: 'rows', role: 'list' }, withSubheads(open, (t) => taskRow(t))) : null,
    done.length ? section('בוצעו', done, { key: 'search:done', collapsible: true, tone: 'success' }) : null,
    !results.length ? emptyState('לא נמצאו משימות', gx`נסה מילה אחרת, שם של אדם, #תגית או מספר משימה`, 'search') : null);
}


// ---------------- Activity: what changed, by whom — and undo a whole batch ----------------
// Hermes often changes several tasks from one WhatsApp message. Consecutive changes by the same actor within
// 10 minutes form a batch, shown together with one "בטל הכל" (undone newest-first; a later edit blocks its own undo).
export function activityView() {
  const items = state.activity;
  const batches = [];
  for (const a of items) {
    const last = batches[batches.length - 1];
    if (last && last.actor === a.actor && Date.parse(last.items[last.items.length - 1].at) - Date.parse(a.at) < 10 * 60_000) last.items.push(a);
    else batches.push({ actor: a.actor, items: [a] });
  }
  const who = (a) => actorInfo(a).name;
  const undoAll = async (batch) => {
    let ok = 0; const failed = [];
    for (const a of batch.items.filter((x) => x.undoable)) {
      try { await undoActivity(a, { quiet: true }); ok += 1; } catch (e) { failed.push(`#${a.task}`); }
    }
    toast(failed.length ? `בוטלו ${ok}; לא בוטלו (השתנו שוב מאז): ${failed.join(', ')}` : `בוטלו ${ok} שינויים`, { iconName: 'undo', tone: failed.length ? 'error' : 'info' });
  };
  return h('div', { class: 'view' },
    header('מה השתנה', state.multi ? 'שינויים אחרונים במשימות שלך ובמשימות הבית — שלך, של הסוכנים ושל מי שחולק איתך' : 'שינויים אחרונים בלוח — שלך, של Hermes ושל Claude Code'),
    !items.length ? emptyState('עוד אין פעילות', `כאן יופיעו שינויים ש־${agentName()} עושה מהווטסאפ.`, 'zap') : null,
    batches.map((batch) => {
      const undoable = batch.items.filter((x) => x.undoable).length;
      return h('section', { class: 'group' },
        h('div', { class: 'group-head' },
          h('div', { class: 'group-title' }, icon(actorInfo(batch.actor).icon, 15), h('span', {}, `${who(batch.actor)} · ${relative(batch.items[0].at)}`), h('span', { class: 'count num' }, batch.items.length)),
          batch.items.length > 1 && undoable ? h('button', { class: 'link-btn', onclick: () => undoAll(batch) }, icon('undo', 14), gx`בטל הכל`) : null),
        h('ol', { class: 'feed feed-page' }, batch.items.map((a) => h('li', { class: 'feed-item' },
          h('div', { class: 'feed-body' },
            h('a', { href: a.task ? `#/task/${a.task}` : '#/settings', class: 'feed-link' }, bdi(a.title || `#${a.task}`)),
            h('div', { class: 'feed-meta' }, a.summary || a.action, ' · ', localTime(a.at))),
          a.undoable ? h('button', { class: 'icon-btn small', title: gx`בטל שינוי זה`, 'aria-label': gx`בטל: ${a.summary || a.action}`, onclick: () => undoActivity(a) }, icon('undo', 15)) : null))));
    }));
}

// ---------------- Free time ("זמן פנוי") ----------------
// When there's an hour to work alone: the independent tasks, ranked by what's most worth doing now (shared logic in
// focus.js, the same ranking Hermes uses). A second mode lists short coordination calls for a spare ten minutes.
export function focusBody() {
  const mode = state.ui['focus:mode'] || 'solo';
  const t = today();
  const open = allTasks().filter((x) => !isDone(x) && isMine(x));
  const maxMinutes = Number(state.ui['focus:time']) || null;
  const ranked = focusList(open, state.schema, t, { kinds: [mode], maxMinutes });
  const hasEffort = state.schema.fields.some((f) => f.id === 'effort');
  const timeChip = (minutes, label) => h('button', { class: ['chip-btn', 'time-chip', (maxMinutes || 0) === minutes && 'on'], 'aria-pressed': String((maxMinutes || 0) === minutes), onclick: () => setUi({ 'focus:time': minutes || null }) }, label);
  const timeBar = hasEffort ? h('div', { class: 'time-bar', role: 'group', 'aria-label': 'כמה זמן יש לי' }, h('span', { class: 'muted small' }, 'כמה זמן יש?'), timeChip(0, 'לא משנה'), EFFORTS.slice(0, 4).map((e) => timeChip(e.minutes, e.label))) : null;
  const now = ranked.filter((r) => !r.later);
  const later = ranked.filter((r) => r.later);
  const unclassified = open.filter((x) => !kindOfTask(x) && statusOf(x.status).category !== 'inbox');
  const seg = (value, label, iconName) => h('button', { class: ['seg', mode === value && 'on'], onclick: () => setUi({ 'focus:mode': value }), 'aria-pressed': String(mode === value) }, icon(iconName, 16), h('span', { class: 'seg-label' }, label));
  const why = (r) => h('div', { class: 'focus-why' }, r.why.map((w) => h('span', { class: 'why-chip' }, w)), r.nextStep ? h('span', { class: 'focus-step' }, 'הצעד הבא: ', bdi(r.nextStep)) : null);
  const top = now[0];
  const hero = top ? h('button', { class: 'focus-hero', onclick: () => openTask(top.task.id) },
    h('span', { class: 'focus-hero-label' }, icon('target', 15), mode === 'solo' ? 'הכי כדאי עכשיו' : 'תיאום ראשון'),
    h('span', { class: 'focus-hero-title' }, bdi(top.task.title)),
    top.why.length ? h('span', { class: 'focus-hero-why' }, top.why.join(' · ')) : null,
    top.nextStep ? h('span', { class: 'focus-hero-step' }, 'הצעד הבא: ', bdi(top.nextStep)) : null) : null;
  const list = (items) => h('div', { class: 'rows' }, items.map((r) => h('div', { class: 'focus-item' }, taskRow(r.task, { showStatus: true, showKind: false }), why(r))));
  const classify = unclassified.length ? h('section', { class: 'group' },
    h('div', { class: 'group-head' }, h('div', { class: 'group-title' }, icon('tag', 15), h('span', {}, 'עוד לא סווגו'), h('span', { class: 'count num' }, unclassified.length))),
    h('div', { class: 'rows' }, unclassified.slice(0, 8).map((x) => h('div', { class: 'classify-row' },
      h('button', { class: 'classify-title', onclick: () => openTask(x.id) }, bdi(x.title)),
      h('div', { class: 'classify-kinds' }, KINDS.map((k) => h('button', { class: `chip-btn kind-${k.id}`, title: k.hint, onclick: () => updateTask(x.id, { fields: { kind: k.label } }) }, icon(k.icon, 13), k.short)))))))
    : null;
  return [
    h('div', { class: 'focus-controls' },
      h('p', { class: 'view-sub' }, mode === 'solo' ? 'משימות שאפשר לקדם לבד, מהכי כדאי' : 'שיחות ותיאומים שאפשר לסגור בכמה דקות'),
      h('div', { class: 'segmented' }, seg('solo', 'עבודה עצמאית', 'user'), seg('coord', 'תיאומים', 'chat'))),
    timeBar,
    hero,
    now.length > 1 ? h('section', { class: 'group' }, h('div', { class: 'group-head' }, h('div', { class: 'group-title' }, h('span', {}, 'אחר כך'), h('span', { class: 'count num' }, now.length - 1))), list(now.slice(1))) : null,
    !now.length ? emptyState(mode === 'solo' ? 'אין כרגע משימות עצמאיות פתוחות' : 'אין תיאומים פתוחים', unclassified.length ? gx`סווג למטה משימות כדי שיופיעו כאן.` : `בקש מ־${agentName()} לסווג משימות חדשות לפי סוג העבודה.`, 'target') : null,
    later.length ? h('section', { class: 'group' }, h('div', { class: 'group-head' }, h('button', { class: 'group-title', onclick: () => setUi({ 'collapsed:focus-later': !state.ui['collapsed:focus-later'] }) }, icon(state.ui['collapsed:focus-later'] ? 'chevron' : 'chevronDown', 14, 'twist'), h('span', {}, 'מתישהו'), h('span', { class: 'count num' }, later.length))), state.ui['collapsed:focus-later'] ? null : list(later)) : null,
    classify];
}
