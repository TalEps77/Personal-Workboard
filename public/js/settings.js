import { api } from './api.js';
import { fail, saveSchema, toast } from './actions.js';
import { allTasks, state, gx, agentName } from './store.js';
import { DAYS_SHORT, h, icon, relative } from './util.js';

const COLORS = ['gray', 'accent', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'pink', 'purple'];
const CATEGORIES = [['inbox', 'תיבה נכנסת — לא ממוין'], ['todo', 'לביצוע'], ['active', 'בעבודה'], ['later', 'מתישהו / מושהה'], ['done', 'בוצע']];
const FIELD_TYPES = [['text', 'טקסט'], ['number', 'מספר'], ['date', 'תאריך'], ['select', 'בחירה מרשימה'], ['url', 'קישור'], ['duration', 'משך זמן'], ['checkbox', 'כן/לא']];
const slug = (prefix) => `${prefix}${Date.now().toString(36).slice(-5)}`;

let notifLog = null;
let sessions = null;
const EMPTY_VIEW = { name: '', status: '', tag: '', due: '', group: 'none', layout: 'list' };
// Unsaved "new view" form, kept outside the DOM so live re-renders don't wipe it.
let viewDraft = { ...EMPTY_VIEW };

const mutate = (fn, message) => saveSchema(fn, message);

const sel = (options, value, onchange) => h('select', { class: 'select', onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
// One dot that opens a small palette (a full row of swatches per status was too noisy, especially on phones).
const colorSel = (value, onchange) => h('details', { class: 'color-pop' },
  h('summary', { title: 'צבע' }, h('span', { class: `swatch c-${value} on` })),
  h('div', { class: 'swatches pop' }, COLORS.map((c) => h('button', { class: ['swatch', `c-${c}`, value === c && 'on'], title: c, onclick: (e) => { e.currentTarget.closest('details').open = false; onchange(c); } }))));
const move = (arr, i, d) => { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; };

function card(title, iconName, desc, ...body) {
  return h('section', { class: 'settings-card' }, h('header', {}, h('h2', {}, icon(iconName, 17), title), desc ? h('p', { class: 'muted small' }, desc) : null), body);
}

function statusesCard() {
  const usage = (id) => allTasks({ archived: true }).filter((t) => t.status === id).length;
  return card('סטטוסים ועמודות הלוח', 'board', 'כל סטטוס הוא עמודה בלוח. ה״סוג״ קובע את ההתנהגות (למשל: ״בוצע״ סוגר משימות ומפסיק תזכורות).',
    h('div', { class: 'srows' }, state.schema.statuses.map((s, i) => h('div', { class: 'srow' },
      h('div', { class: 'reorder' }, h('button', { class: 'icon-btn small', title: 'למעלה', disabled: i === 0, onclick: () => mutate((x) => move(x.statuses, i, -1)) }, '▲'), h('button', { class: 'icon-btn small', title: 'למטה', disabled: i === state.schema.statuses.length - 1, onclick: () => mutate((x) => move(x.statuses, i, 1)) }, '▼')),
      h('input', { class: 'input', value: s.label, dir: 'auto', onchange: (e) => mutate((x) => { x.statuses[i].label = e.target.value.trim() || s.label; }) }),
      sel(CATEGORIES, s.category, (v) => mutate((x) => { x.statuses[i].category = v; })),
      colorSel(s.color, (c) => mutate((x) => { x.statuses[i].color = c; })),
      h('span', { class: 'muted small num' }, `${usage(s.id)} משימות`),
      h('button', { class: 'icon-btn small', title: usage(s.id) ? 'אי אפשר למחוק סטטוס שיש בו משימות' : gx`מחק`, disabled: usage(s.id) > 0, onclick: () => mutate((x) => { x.statuses.splice(i, 1); }, 'הסטטוס נמחק') }, icon('trash', 14))))),
    h('button', { class: 'btn ghost small', onclick: () => mutate((x) => { x.statuses.splice(x.statuses.findIndex((s) => s.category === 'done'), 0, { id: slug('s'), label: 'סטטוס חדש', category: 'active', color: 'teal' }); }, 'נוסף סטטוס') }, icon('plus', 14), gx`הוסף סטטוס`));
}

function prioritiesCard() {
  return card('עדיפויות', 'flag', null,
    h('div', { class: 'srows' }, state.schema.priorities.map((p, i) => h('div', { class: 'srow' },
      h('input', { class: 'input', value: p.label, dir: 'auto', onchange: (e) => mutate((x) => { x.priorities[i].label = e.target.value.trim() || p.label; }) }),
      colorSel(p.color, (c) => mutate((x) => { x.priorities[i].color = c; })),
      h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'defprio', checked: state.schema.defaultPriority === p.id, onchange: () => mutate((x) => { x.defaultPriority = p.id; }) }), 'ברירת מחדל')))));
}

function fieldsCard() {
  const projects = state.schema.projects.filter((p) => !p.archived);
  return card('שדות מותאמים', 'sparkles', 'שדות נוספים למשימה — למשל ״לקוח״, ״איש קשר״, ״הערכת זמן״. אפשר להגביל שדה לפרויקטים מסוימים. מומלץ לשמור על מעט שדות.',
    state.schema.fields.length ? h('div', { class: 'srows' }, state.schema.fields.map((f, i) => h('div', { class: 'srow wrap' },
      h('input', { class: 'input', value: f.label, dir: 'auto', onchange: (e) => mutate((x) => { x.fields[i].label = e.target.value.trim() || f.label; }) }),
      sel(FIELD_TYPES, f.type, (v) => mutate((x) => { x.fields[i].type = v; if (v === 'select' && !x.fields[i].options?.length) x.fields[i].options = ['אפשרות 1', 'אפשרות 2']; })),
      f.type === 'select' ? h('input', { class: 'input', value: (f.options || []).join(', '), dir: 'auto', title: 'אפשרויות, מופרדות בפסיק', onchange: (e) => mutate((x) => { x.fields[i].options = e.target.value.split(',').map((o) => o.trim()).filter(Boolean); }) }) : null,
      sel([['', 'כל הפרויקטים'], ...projects.map((p) => [p.id, `רק ${p.name}`])], f.projects?.[0] || '', (v) => mutate((x) => { x.fields[i].projects = v ? [v] : undefined; })),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: f.showOnCard, onchange: (e) => mutate((x) => { x.fields[i].showOnCard = e.target.checked; }) }), gx`הצג בכרטיס`),
      h('button', { class: 'icon-btn small', title: gx`מחק שדה (הערכים נשארים בקבצים)`, onclick: () => mutate((x) => { x.fields.splice(i, 1); }, 'השדה הוסר') }, icon('trash', 14)))))
      : h('p', { class: 'muted small' }, 'אין שדות מותאמים עדיין.'),
    h('button', { class: 'btn ghost small', onclick: () => mutate((x) => { x.fields.push({ id: slug('f'), label: 'שדה חדש', type: 'text', showOnCard: false }); }, 'נוסף שדה') }, icon('plus', 14), gx`הוסף שדה`));
}

function viewsCard() {
  const statuses = state.schema.statuses;
  const describe = (v) => {
    const f = v.filter || {};
    const parts = [];
    if (f.status?.length) parts.push(`סטטוס: ${f.status.map((id) => statuses.find((s) => s.id === id)?.label || id).join(', ')}`);
    if (f.project?.length) parts.push(`פרויקט: ${f.project.map((id) => state.schema.projects.find((p) => p.id === id)?.name || id).join(', ')}`);
    if (f.tags?.length) parts.push(`תגיות: ${f.tags.map((t) => `#${t}`).join(' ')}`);
    if (f.priority?.length) parts.push(`עדיפות: ${f.priority.join(', ')}`);
    if (f.due) parts.push({ overdue: 'באיחור', today: 'להיום', week: 'השבוע' }[f.due]);
    if (f.text) parts.push(`״${f.text}״`);
    return parts.join(' · ') || 'כל המשימות';
  };
  const d = viewDraft;
  const keep = (key) => (e) => { d[key] = e.target.value; };
  const name = h('input', { class: 'input', placeholder: 'שם התצוגה, למשל ״שיחות לחזור״', dir: 'auto', value: d.name, dataset: { key: 'vf-name' }, oninput: keep('name') });
  const status = sel([['', 'כל הסטטוסים'], ...statuses.map((s) => [s.id, s.label])], d.status, (v) => { d.status = v; });
  const tag = h('input', { class: 'input', placeholder: 'תגית (לא חובה)', dir: 'auto', value: d.tag, dataset: { key: 'vf-tag' }, oninput: keep('tag') });
  const due = sel([['', 'כל התאריכים'], ['today', 'להיום'], ['week', 'השבוע'], ['overdue', 'באיחור']], d.due, (v) => { d.due = v; });
  const group = sel([['none', 'בלי קיבוץ'], ['status', 'לפי סטטוס'], ['project', 'לפי פרויקט'], ['priority', 'לפי עדיפות']], d.group, (v) => { d.group = v; });
  const layout = sel([['list', 'רשימה'], ['board', 'לוח']], d.layout, (v) => { d.layout = v; });
  const add = async () => {
    if (!d.name.trim()) { name.focus(); return; }
    const filter = {};
    if (d.status) filter.status = [d.status];
    if (d.tag.trim()) filter.tags = [d.tag.trim().replace(/^#/, '')];
    if (d.due) filter.due = d.due;
    const saved = await mutate((x) => { x.views.push({ id: slug('v'), name: d.name.trim(), icon: '★', filter, sort: 'priority', group: d.group, layout: d.layout }); }, 'התצוגה נוספה לתפריט');
    if (saved) viewDraft = { ...EMPTY_VIEW };
  };
  return card('תצוגות שמורות', 'star', `תצוגות מופיעות בתפריט הצד. ${agentName()} יכול ליצור תצוגות מורכבות יותר (סינון לפי פרויקט, עדיפות, טקסט).`,
    h('div', { class: 'srows' }, state.schema.views.map((v, i) => h('div', { class: 'srow' },
      h('input', { class: 'input', value: v.name, dir: 'auto', onchange: (e) => mutate((x) => { x.views[i].name = e.target.value.trim() || v.name; }) }),
      h('span', { class: 'muted small grow' }, describe(v)),
      h('a', { class: 'icon-btn small', href: `#/view/${v.id}`, title: gx`פתח` }, icon('external', 14)),
      h('button', { class: 'icon-btn small', title: gx`מחק תצוגה`, onclick: () => mutate((x) => { x.views.splice(i, 1); }, 'התצוגה נמחקה') }, icon('trash', 14))))),
    h('div', { class: 'view-form' }, name, status, tag, due, group, layout, h('button', { class: 'btn primary small', onclick: add }, icon('plus', 14), gx`צור תצוגה`)));
}

function notificationsCard() {
  const n = state.schema.notifications;
  if (notifLog === null) { notifLog = []; api.notifications().then((r) => { notifLog = r.items; document.dispatchEvent(new Event('wb:rerender')); }).catch(() => {}); }
  const time = (value, onchange) => h('input', { type: 'time', class: 'date-input', value, onchange: (e) => e.target.value && onchange(e.target.value) });
  return card('תזכורות ו־WhatsApp', 'bell', `התזכורות נשלחות מתוך Workboard עצמו, דרך ${agentName()}, לווטסאפ שלך.`,
    h('div', { class: ['connection', state.notifier.configured ? 'ok' : 'bad'] }, icon(state.notifier.configured ? 'checkCircle' : 'x', 16), state.notifier.configured ? `מחובר ל־${agentName()}` : `החיבור ל־${agentName()} לא הוגדר`,
      h('button', { class: 'btn ghost small', disabled: !state.notifier.configured, onclick: async () => { try { await api.testNotification(); toast('הודעת בדיקה נשלחה לווטסאפ', { tone: 'success', iconName: 'chat' }); notifLog = null; } catch (e) { fail(e); } } }, icon('chat', 14), gx`שלח הודעת בדיקה`)),
    h('label', { class: 'switch-row' }, h('input', { type: 'checkbox', checked: n.enabled, onchange: (e) => mutate((x) => { x.notifications.enabled = e.target.checked; }) }), h('span', {}, 'שליחת תזכורות פעילה')),
    h('div', { class: 'srow' }, h('span', {}, 'שעות שקטות לנדנודים:'), time(n.quietHours.start, (v) => mutate((x) => { x.notifications.quietHours.start = v; })), h('span', {}, 'עד'), time(n.quietHours.end, (v) => mutate((x) => { x.notifications.quietHours.end = v; }))),
    h('label', { class: 'switch-row' }, h('input', { type: 'checkbox', checked: n.digest.enabled, onchange: (e) => mutate((x) => { x.notifications.digest.enabled = e.target.checked; }, e.target.checked ? 'סיכום בוקר הופעל' : 'סיכום בוקר כובה') }), h('span', {}, 'סיכום בוקר בווטסאפ (מה באיחור, מה להיום, תזכורות)')),
    n.digest.enabled ? h('div', { class: 'srow' }, h('span', {}, 'בשעה'), time(n.digest.time, (v) => mutate((x) => { x.notifications.digest.time = v; })),
      h('div', { class: 'mini-group' }, DAYS_SHORT.map((d, i) => h('button', { class: ['mini', n.digest.days.includes(i) && 'on'], onclick: () => mutate((x) => { const days = new Set(x.notifications.digest.days); days.has(i) ? days.delete(i) : days.add(i); x.notifications.digest.days = [...days].sort(); }) }, d)))) : null,
    notifLog?.length ? h('details', { class: 'log', dataset: { key: 'notif-log' } }, h('summary', {}, `הודעות אחרונות (${notifLog.length})`), h('ol', {}, notifLog.map((r) => h('li', { class: r.ok ? '' : 'danger' }, h('span', { class: 'muted small' }, relative(r.at)), ' ', r.ok ? '✓' : `✗ ${r.error}`, ' ', h('span', { class: 'small' }, (r.message || '').split('\n').slice(0, 2).join(' — ').replace(/\*/g, '')))))) : null);
}

function devicesCard() {
  if (sessions === null) { sessions = []; api.sessions().then((r) => { sessions = r.items; document.dispatchEvent(new Event('wb:rerender')); }).catch(() => {}); }
  const revoke = async (s) => {
    if (!confirm(s.current ? gx`לנתק את המכשיר הזה? תצטרך/י קוד חדש כדי להתחבר שוב.` : `לנתק את ״${s.device}״?`)) return;
    try { await api.revokeSession(s.id); toast('המכשיר נותק', { iconName: 'check' }); if (s.current) location.reload(); sessions = null; document.dispatchEvent(new Event('wb:rerender')); } catch (e) { fail(e); }
  };
  return card('מכשירים מחוברים', 'monitor', 'כל מכשיר מחובר פעם אחת בקוד מווטסאפ. מכשיר שלא מזוהה לך — נתק אותו.',
    sessions.length ? h('div', { class: 'srows' }, sessions.map((s) => h('div', { class: 'srow' },
      icon(/iPhone|Android/.test(s.device) ? 'chat' : 'monitor', 16),
      h('strong', { class: 'grow' }, s.device, s.current ? h('span', { class: 'pill c-green', style: { marginInlineStart: '8px' } }, 'המכשיר הזה') : null),
      h('span', { class: 'muted small' }, `חובר ${relative(s.created_at)} · פעיל ${relative(s.last_seen)}`),
      h('button', { class: 'btn ghost small', onclick: () => revoke(s) }, 'נתק'))))
      : h('p', { class: 'muted small' }, 'טוען…'));
}

function jsonCard() {
  const area = h('textarea', { class: 'json', dir: 'ltr', spellcheck: 'false', dataset: { key: 'schema-json' } }, JSON.stringify(state.schema, null, 2));
  return card('מתקדם: board.json', 'settings', `זה כל המבנה כ־JSON — אותו קובץ ש־${agentName()} עורך. השמירה נבדקת, אז טעות לא תשבור את הלוח.`,
    h('details', { dataset: { key: 'json-details' } }, h('summary', {}, gx`הצג / ערוך JSON`), area,
      h('button', { class: 'btn primary small', onclick: () => { try { const parsed = JSON.parse(area.value); saveSchema(() => parsed, 'board.json נשמר'); } catch (e) { fail(new Error(`JSON לא תקין: ${e.message}`)); } } }, gx`שמור JSON`)));
}

export function settingsView() {
  return h('div', { class: 'view settings' },
    h('header', { class: 'view-head' }, h('div', {}, h('h1', {}, 'מבנה והגדרות'), h('p', { class: 'view-sub' }, `הכלי נבנה סביבך. אפשר לשנות כאן — או פשוט לבקש מ־${agentName()} בווטסאפ.`))),
    h('div', { class: 'agent-hint' }, icon('bot', 18), h('div', {}, h('strong', {}, `דוגמאות למה לבקש מ־${agentName()}: `), '״תוסיף סטטוס ׳בבדיקה׳ אחרי ׳בעבודה׳״ · ״תוסיף שדה ׳לקוח׳ לפרויקט מכרזים״ · ״תעשה תצוגה של כל מה שמחכה לאחרים״ · ״תשלח לי סיכום כל בוקר ב־8״')),
    statusesCard(), notificationsCard(), devicesCard(), fieldsCard(), viewsCard(), prioritiesCard(), jsonCard());
}
export function resetSettingsCache() { notifLog = null; sessions = null; }
