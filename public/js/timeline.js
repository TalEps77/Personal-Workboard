// Timeline ("ציר זמן"): a Gantt of tasks by project, with project goals and milestones on the same axis.
// RTL: time runs right → left, like reading (HIG: right to left: flip controls that show progress over time).
import { emptyState, openTask, taskRow } from './components.js';
import { allTasks, isDone, matches, projectOf, setUi, sortTasks, state, taskDate, gx, agentName } from './store.js';
import { eventItem } from './schedule.js';
import { DAYS, DAYS_SHORT, addDays, bdi, daysBetween, dow, h, icon, localDate, localTime, niceDate, today, isWorkday } from './util.js';

const MONTHS = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'];

/** A task's span on the axis: planned day → deadline (either alone = one day). */
export function spanOf(task) {
  const start = task.when || task.deadline;
  const end = task.deadline || task.when;
  if (!start) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

function range(tasks, projects) {
  const t = today();
  const dates = [...tasks.flatMap((x) => { const s = spanOf(x); return s ? [s.start, s.end] : []; }), ...projects.flatMap((p) => [p.due, ...p.milestones.map((m) => m.date)]).filter(Boolean)];
  const max = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : t;
  const min = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : t;
  // From a few days back (or the earliest overdue item) to at least four weeks ahead, capped at ~4 months.
  const from = addDays(min < t ? (daysBetween(min, t) > 21 ? addDays(t, -21) : min) : t, -3);
  let to = max > addDays(t, 27) ? max : addDays(t, 27);
  if (daysBetween(from, to) > 120) to = addDays(from, 120);
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

export function ganttChart(tasks, projects, { showUndated = true } = {}) {
  const t = today();
  const days = range(tasks, projects);
  const col = (d) => days.indexOf(d);
  const clampCol = (d) => (d < days[0] ? 0 : d > days[days.length - 1] ? days.length - 1 : col(d));
  const n = days.length;
  const grid = (cls, ...cells) => h('div', { class: ['g-row', cls], style: { gridTemplateColumns: `var(--g-label) repeat(${n}, var(--g-day))` } }, cells);
  const todayCol = col(t);

  const header = [
    grid('g-months', h('div', { class: 'g-label g-corner' }), days.map((d, i) => (i === 0 || d.endsWith('-01') ? h('div', { class: 'g-month', style: { gridColumn: `${i + 2} / span 7` } }, `${MONTHS[Number(d.slice(5, 7)) - 1]}`) : null))),
    grid('g-days', h('div', { class: 'g-label g-corner' }), days.map((d, i) => h('div', { class: ['g-day', !isWorkday(d) && 'weekend', d === t && 'is-today', dow(d) === 0 && 'week-start'], style: { gridColumn: `${i + 2}` }, dataset: d === t ? { today: '1' } : {} }, h('span', { class: 'g-dow' }, DAYS_SHORT[dow(d)]), h('span', { class: 'g-num num' }, Number(d.slice(8)))))),
  ];

  const groups = [...projects.map((p) => ({ project: p, tasks: tasks.filter((x) => x.project === p.id) })), { project: null, tasks: tasks.filter((x) => !x.project || !projectOf(x.project)) }]
    .filter((g) => g.tasks.length || g.project?.milestones.length || g.project?.due);

  const body = groups.map(({ project, tasks: list }) => {
    const dated = sortTasks(list.filter((x) => spanOf(x)), 'when').sort((a, b) => spanOf(a).start.localeCompare(spanOf(b).start));
    const undated = list.filter((x) => !spanOf(x));
    const color = project?.color || 'gray';
    const marks = [];
    if (project) {
      project.milestones.filter((m) => m.date && m.date >= days[0] && m.date <= days[n - 1]).forEach((m) => marks.push(
        h('button', { class: ['g-milestone', m.done && 'done'], style: { gridColumn: `${col(m.date) + 2}` }, title: `${m.title} · ${niceDate(m.date)}`, onclick: () => { location.hash = `#/project/${project.id}`; } }, h('span', { class: 'g-diamond' }), h('span', { class: 'g-mlabel' }, bdi(m.title)))));
      if (project.due && project.due >= days[0] && project.due <= days[n - 1]) marks.push(h('div', { class: 'g-due', style: { gridColumn: `${col(project.due) + 2}` }, title: `יעד הפרויקט: ${niceDate(project.due)}` }, icon('flag', 14)));
    }
    return h('section', { class: `g-group c-${color}` },
      grid('g-project', h('a', { class: 'g-label g-plabel', href: project ? `#/project/${project.id}` : '#/all' }, h('span', { class: 'dot' }), bdi(project ? project.name : 'ללא פרויקט'), h('span', { class: 'g-count num' }, list.filter((x) => !isDone(x)).length)), marks),
      dated.map((x) => {
        const s = spanOf(x);
        const a = clampCol(s.start); const b = clampCol(s.end);
        const overdue = x.deadline && x.deadline < t && !isDone(x);
        return grid('g-task',
          h('button', { class: 'g-label g-tlabel', onclick: () => openTask(x.id) }, bdi(x.title)),
          h('button', { class: ['g-bar', isDone(x) && 'done', overdue && 'overdue', s.start === s.end && 'single', s.start < days[0] && 'cut-start', s.end > days[n - 1] && 'cut-end'], style: { gridColumn: `${a + 2} / ${b + 3}` }, title: `${x.title} · ${niceDate(s.start)}${s.end !== s.start ? ` → ${niceDate(s.end)}` : ''}`, onclick: () => openTask(x.id) },
            h('span', { class: 'g-bar-text' }, bdi(x.title))));
      }),
      showUndated && undated.length ? grid('g-undated', h('div', { class: 'g-label g-ulabel' }, `+ ${undated.length} ללא תאריך`)) : null);
  });

  const chart = h('div', { class: 'gantt', style: { '--g-today': todayCol } },
    h('div', { class: 'g-scroll' },
      h('div', { class: 'g-inner', style: { inlineSize: `calc(var(--g-label) + ${n} * var(--g-day))` } },
        todayCol >= 0 ? h('div', { class: 'g-today-line', style: { insetInlineStart: `calc(var(--g-label) + ${todayCol} * var(--g-day) + var(--g-day) / 2)` } }) : null,
        header, body)));
  // Open with today in view.
  requestAnimationFrame(() => chart.querySelector('[data-today]')?.scrollIntoView({ inline: 'center', block: 'nearest' }));
  return chart;
}

function agenda(tasks, projects) {
  const t = today();
  const open = tasks.filter((x) => !isDone(x));
  // Same rule as every other screen (store.horizonOf): only a passed deadline is overdue; a passed work day is
  // carried into today.
  const overdue = (x) => x.deadline && x.deadline < t;
  const keyDate = (x) => { const d = taskDate(x); return d && !overdue(x) && d < t ? t : d; };
  const items = new Map();
  const push = (d, el) => { if (!items.has(d)) items.set(d, []); items.get(d).push(el); };
  sortTasks(open.filter(overdue), 'date').forEach((x) => push('overdue', taskRow(x)));
  for (let i = 0; i <= 20; i += 1) {
    const d = addDays(t, i);
    projects.forEach((p) => p.milestones.filter((m) => m.date === d && !m.done).forEach((m) => push(d, h('a', { class: `agenda-milestone c-${p.color}`, href: `#/project/${p.id}` }, h('span', { class: 'g-diamond' }), bdi(m.title), h('span', { class: 'muted small' }, ` · ${p.name}`)))));
    // The schedule first (it has times), then milestones, reminders and the day's tasks.
    state.events.filter((e) => e.date === d).sort((a, b) => a.start.localeCompare(b.start)).forEach((e) => push(d, eventItem(e)));
    projects.filter((p) => p.due === d).forEach((p) => push(d, h('a', { class: `agenda-milestone c-${p.color}`, href: `#/project/${p.id}` }, icon('flag', 14), `יעד: ${p.name}`)));
    open.forEach((x) => x.reminders.filter((r) => !r.done && localDate(r.at) === d).forEach((r) => push(d, h('div', { class: 'agenda-rem', onclick: () => openTask(x.id) }, icon('bell', 13), h('span', { class: 'num', dir: 'ltr' }, localTime(r.at)), bdi(x.title)))));
    sortTasks(open.filter((x) => !overdue(x) && keyDate(x) === d), 'date').forEach((x) => push(d, taskRow(x)));
  }
  const later = sortTasks(open.filter((x) => !overdue(x) && keyDate(x) && keyDate(x) > addDays(t, 20)), 'date');
  const sections = [...items.entries()].map(([d, els]) => h('section', { class: ['agenda-day', d === 'overdue' && 'tone-danger'] },
    h('div', { class: 'agenda-date' }, d === 'overdue' ? h('span', { class: 'agenda-dow danger' }, 'באיחור') : [h('span', { class: 'agenda-dow' }, niceDate(d) === 'היום' || niceDate(d) === 'מחר' ? niceDate(d) : `יום ${DAYS[dow(d)]}`), h('span', { class: 'agenda-num num' }, `${Number(d.slice(8))}.${Number(d.slice(5, 7))}`)]),
    h('div', { class: 'agenda-items' }, els)));
  return h('div', { class: 'agenda' }, sections.length ? sections : emptyState('אין שום דבר מתוזמן', gx`תן למשימות תאריך עבודה או דדליין — או בקש מ־${agentName()} לתזמן.`, 'calendar'),
    later.length ? h('section', { class: 'agenda-day' }, h('div', { class: 'agenda-date' }, h('span', { class: 'agenda-dow' }, 'בהמשך')), h('div', { class: 'agenda-items' }, later.map((x) => taskRow(x)))) : null);
}

export function timelineView() {
  const phone = matchMedia('(max-width: 820px)').matches;
  // The Gantt needs width: on the phone the יומן is the agenda only.
  const layout = phone ? 'agenda' : state.ui['layout:timeline'] || 'gantt';
  const tasks = allTasks().filter((x) => !isDone(x) && matches(x, {}, state.search));
  const projects = state.schema.projects.filter((p) => !p.archived);
  const undated = tasks.filter((x) => !spanOf(x)).length;
  const seg = (value, iconName, label) => h('button', { class: ['seg', layout === value && 'on'], onclick: () => setUi({ 'layout:timeline': value }), 'aria-pressed': String(layout === value) }, icon(iconName, 16), h('span', {}, label));
  return h('div', { class: ['view', layout === 'gantt' && 'wide'] },
    h('header', { class: 'view-head' },
      h('div', {}, h('h1', {}, 'יומן'), h('p', { class: 'view-sub' }, undated ? `${undated} משימות עדיין בלי תאריך — לא יופיעו על הציר עד שיקבלו תאריך עבודה או דדליין` : 'כל המשימות מתוזמנות')),
      phone ? null : h('div', { class: 'segmented' }, seg('agenda', 'list', 'לפי ימים'), seg('gantt', 'board', 'גאנט'))),
    layout === 'gantt' ? ganttChart(tasks, projects) : agenda(tasks, projects),
    // Undated work is listed under the chart (not squeezed into it), so it can be given a date.
    layout === 'gantt' && undated ? h('section', { class: 'group', style: { marginBlockStart: '24px' } },
      h('div', { class: 'group-head' }, h('div', { class: 'group-title' }, icon('calendar', 15), h('span', {}, 'עדיין בלי תאריך'), h('span', { class: 'count num' }, undated))),
      h('div', { class: 'rows' }, sortTasks(tasks.filter((x) => !spanOf(x)), 'priority').slice(0, 8).map((x) => taskRow(x))),
      undated > 8 ? h('p', { class: 'muted small', style: { margin: '8px 4px' } }, `ועוד ${undated - 8} — אפשר לבקש מ־${agentName()}: ״תתזמן לי את המשימות של השבוע״`) : null) : null);
}
