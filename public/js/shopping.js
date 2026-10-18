// The household's shopping lists — all on one screen, all shared: סופר (by department, in walking order), פארם,
// לבית (things no shop category fits), אישי and Wish (each item says who added it). On a wish someone else added,
// "אני אקנה" quietly reserves it as a gift; the one who wished never sees that. Home opens on סופר, personal on אישי. "בסופר" mode is for the store: big rows, ticked items drop into the cart,
// the screen stays awake, and "סיימתי" clears the cart (with undo).
import { api } from './api.js';
import { toast } from './actions.js';
import { currentKind, setState, setUi, state, gx } from './store.js';
import { bdi, h, icon } from './util.js';
import { attachSwipe, closeOpenSwipe } from './components.js';

const deptOf = (id) => state.depts.find((d) => d.id === id) || { id: 'other', label: 'אחר', icon: '🛒' };
/** The lists this context is about: home → סופר + פארם; personal → mine; everything else → all of them. */
export const listsHere = () => state.shopping?.lists || [];
const listInfo = (id) => (state.shopping?.lists || []).find((l) => l.id === id) || null;
export const listLabel = (l) => l.label;
/** The lists this context is about first: home → the shop lists; personal → אישי + Wish. */
const contextLists = () => listsHere().filter((l) => (currentKind() === 'personal' ? l.byline : currentKind() === 'home' ? l.home : true));
const currentList = () => { const all = listsHere(); const saved = state.ui[`shop:list:${currentKind()}`]; return all.find((l) => l.id === saved) || contextLists()[0] || all[0] || null; };
const openIn = (ids) => (state.shopping?.items || []).filter((x) => !x.done && ids.includes(x.list));
export const shoppingCount = () => openIn(contextLists().map((l) => l.id)).length;
const nameOf = (id) => (id === state.me?.id ? 'שלי' : state.people.find((p) => p.id === id)?.name || '');
const theirWish = (item) => listInfo(item.list)?.wish && item.by && item.by !== state.me?.id;
const other = () => state.people.find((p) => p.id !== state.me?.id) || null;

function setItems(fn) {
  const items = fn(state.shopping.items.map((x) => ({ ...x })));
  setState({ shopping: { ...state.shopping, items } });
}
export async function refreshShopping() {
  try { setState({ shopping: await api.shopping() }); } catch { /* offline: keep what we have */ }
}

async function add(text, list, extra = {}) {
  // "חלב, ביצים, 2 לחם" → three items; a leading number is the quantity.
  const parts = text.split(/[,،\n]/).map((x) => x.trim()).filter(Boolean).map((x) => { const m = x.match(/^(\d+(?:\.\d+)?)\s+(.+)$/); return m ? { text: m[2], qty: m[1] } : { text: x }; });
  if (!parts.length) return;
  try {
    const { results } = await api.addShopping(parts.map((x) => ({ ...x, ...extra, list: list.id })));
    await refreshShopping();
    const dup = results.filter((r) => r.status === 'exists').map((r) => r.item.text);
    if (dup.length) toast(`כבר ברשימה: ${dup.join(', ')}`, { iconName: 'cart' });
  } catch (error) { toast(error.message, { tone: 'error' }); }
}

async function toggle(item) {
  setItems((items) => items.map((x) => (x.id === item.id ? { ...x, done: !item.done } : x)));
  if (!item.done) navigator.vibrate?.(8);
  try { await api.updateShopping(item.id, { done: !item.done }); } catch (error) { setItems((items) => items.map((x) => (x.id === item.id ? { ...x, done: item.done } : x))); toast(error.message, { tone: 'error' }); }
}

async function claim(item) {
  const on = !item.claimed_by;
  setItems((items) => items.map((x) => (x.id === item.id ? { ...x, claimed_by: on ? state.me?.id : null } : x)));
  try {
    await api.claimShopping(item.id, on);
    toast(on ? gx`סימנת שאת/ה קונה: ${item.text} — רק את/ה רואה את זה` : 'הסימון הוסר', { iconName: 'check' });
  } catch (error) { refreshShopping(); toast(error.message, { tone: 'error' }); }
}

async function remove(item) {
  setItems((items) => items.filter((x) => x.id !== item.id));
  try {
    await api.removeShopping(item.id);
    toast(`״${item.text}״ הוסר`, { iconName: 'trash', action: { label: 'ביטול', fn: async () => { await api.restoreShopping([item]); refreshShopping(); } } });
  } catch (error) { refreshShopping(); toast(error.message, { tone: 'error' }); }
}

async function finish(list) {
  const cart = (state.shopping?.items || []).filter((x) => x.done && x.list === list.id);
  if (!cart.length) return;
  setItems((items) => items.filter((x) => !(x.done && x.list === list.id)));
  try {
    const { finished } = await api.finishShopping(list.id);
    refreshShopping();
    toast(`${list.label}: ${finished.length} פריטים שנקנו ירדו מהרשימה`, { iconName: 'check', tone: 'success', timeout: 8000, action: { label: 'ביטול', fn: async () => { await api.restoreShopping(finished); refreshShopping(); } } });
  } catch (error) { refreshShopping(); toast(error.message, { tone: 'error' }); }
}

// ---- Item sheet: edit, move department (remembered), delete ----
let host = null;
const closeSheet = () => { host?.remove(); host = null; };
window.addEventListener('hashchange', closeSheet);
function openItem(item) {
  closeSheet();
  const openedAt = Date.now();
  const text = h('input', { class: 'input', value: item.text, dir: 'auto', 'aria-label': 'פריט' });
  const qty = h('input', { class: 'input', value: item.qty || '', dir: 'auto', placeholder: 'כמות', 'aria-label': 'כמות' });
  const note = h('input', { class: 'input', value: item.note || '', dir: 'auto', placeholder: 'הערה (מותג, גודל…)', 'aria-label': 'הערה' });
  const save = async (patch) => {
    try { await api.updateShopping(item.id, patch); await refreshShopping(); } catch (error) { toast(error.message, { tone: 'error' }); }
  };
  const saveText = () => { const patch = {}; if (text.value.trim() && text.value.trim() !== item.text) patch.text = text.value.trim(); if (qty.value.trim() !== (item.qty || '')) patch.qty = qty.value.trim(); if (note.value.trim() !== (item.note || '')) patch.note = note.value.trim(); return Object.keys(patch).length ? save(patch) : null; };
  host = h('div', { class: 'as-host', onclick: (e) => { if (e.target === host && Date.now() - openedAt > 450) { saveText(); closeSheet(); } }, onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSheet(); } } },
    h('div', { class: 'action-sheet shop-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': item.text },
      h('div', { class: 'as-head' }, h('div', { class: 'as-task' }, bdi(item.text)), h('button', { class: 'icon-btn small', 'aria-label': gx`סגור`, onclick: () => { saveText(); closeSheet(); } }, icon('x', 16))),
      h('div', { class: 'ev-form' }, h('label', { class: 'ev-field' }, h('span', {}, 'פריט'), text), h('div', { class: 'ev-row' }, h('label', { class: 'ev-field' }, h('span', {}, 'כמות'), qty), h('label', { class: 'ev-field' }, h('span', {}, 'הערה'), note))),
      listInfo(item.list)?.depts ? [h('div', { class: 'as-label' }, 'מחלקה (אזכור להבא)'),
        h('div', { class: 'as-chip-row wrap' }, state.depts.map((d) => h('button', { class: ['chip-btn', item.dept === d.id && 'on'], 'aria-pressed': String(item.dept === d.id), onclick: async () => { await saveText(); await save({ dept: d.id }); closeSheet(); } }, `${d.icon} ${d.label}`)))] : null,
      h('div', { class: 'as-label' }, gx`העבר לרשימה`),
      h('div', { class: 'as-chip-row wrap' }, (state.shopping?.lists || []).filter((l) => l.id !== item.list).map((l) => h('button', { class: 'chip-btn', onclick: async () => { await saveText(); await save({ list: l.id }); closeSheet(); toast(`הועבר ל${listLabel(l)}`, { iconName: 'cart' }); } }, `${l.icon} ${listLabel(l)}`))),
      h('div', { class: 'as-chip-row ev-actions' },
        h('button', { class: 'as-item', onclick: async () => { await saveText(); closeSheet(); } }, icon('check', 16), gx`שמור`),
        h('button', { class: 'as-item tone-danger', onclick: () => { closeSheet(); remove(item); } }, icon('trash', 16), 'הסר מהרשימה'))));
  document.body.append(host);
}

/** On אישי and Wish: whose it is. (Shop lists are the household's — no names there.) */
const byTag = (item) => (listInfo(item.list)?.byline && item.by ? h('span', { class: ['by-tag', item.by === state.me?.id && 'me'] }, nameOf(item.by)) : null);

/** A wish the partner added: tap "אני אקנה" to quietly reserve it (they never see it); ⋯ still edits. */
function wishRow(item) {
  const me = item.claimed_by === state.me?.id;
  const taken = item.claimed_by && !me;
  return h('div', { class: ['shop-row', 'wish-row', item.done && 'done'] },
    h('span', { class: 'shop-text' }, bdi(item.text), item.qty ? h('span', { class: 'shop-qty num' }, item.qty) : null, byTag(item), item.note ? h('span', { class: 'shop-note' }, bdi(item.note)) : null),
    taken ? h('span', { class: 'claim-tag' }, `🤫 ${state.people.find((p) => p.id === item.claimed_by)?.name || ''} קונה`)
      : h('button', { class: ['claim-btn', me && 'on'], 'aria-pressed': String(me), onclick: () => claim(item) }, me ? gx`🤫 את/ה קונה` : 'אני אקנה'));
}

function itemRow(item, big) {
  if (theirWish(item) && !item.done) return wishRow(item);
  const row = h('div', { class: ['shop-row', item.done && 'done', big && 'big'], role: 'checkbox', 'aria-checked': String(item.done), tabindex: 0,
    onclick: () => toggle(item), onkeydown: (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(item); } } },
  h('span', { class: 'shop-check', 'aria-hidden': 'true' }, item.done ? icon('check', big ? 18 : 15) : null),
  h('span', { class: 'shop-text' }, bdi(item.text), item.qty ? h('span', { class: 'shop-qty num' }, item.qty) : null, byTag(item), item.note ? h('span', { class: 'shop-note' }, bdi(item.note)) : null),
  h('button', { class: 'row-menu', 'aria-label': `עריכה: ${item.text}`, onclick: (e) => { e.stopPropagation(); openItem(item); } }, icon('more', 18)));
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); openItem(item); });
  // Swipe like Reminders: left reveals "הסר" (a long swipe removes, with undo); right reveals "עריכה".
  const btn = (label, iconName, tone, run) => h('button', { class: `swipe-btn tone-${tone}`, onclick: (e) => { e.stopPropagation(); closeOpenSwipe(); run(); } }, icon(iconName, 20), h('span', {}, label));
  const wrap = h('div', { class: 'swipe shop-swipe' },
    h('div', { class: 'swipe-actions lead' }, btn('הסר', 'trash', 'red', () => remove(item))),
    h('div', { class: 'swipe-actions trail' }, btn('עריכה', 'note', 'gray', () => openItem(item))),
    row);
  attachSwipe(wrap, row, 84, 84, () => remove(item));
  return wrap;
}

/** On Today (home / personal): the lists of this context with what's on them, and one tap to the store. */
export function shoppingCard() {
  const lists = contextLists();
  if (!lists.length) return null;
  const open = openIn(lists.map((l) => l.id));
  const counts = lists.map((l) => `${listLabel(l)} ${openIn([l.id]).length}`).join(' · ');
  const names = open.slice(0, 3).map((x) => x.text).join(' · ');
  const home = currentKind() === 'home';
  return h('section', { class: 'shop-card', 'aria-label': 'קניות' },
    h('a', { class: 'shop-card-main', href: '#/shopping' },
      h('span', { class: 'shop-card-icon' }, icon('cart', 20)),
      h('span', { class: 'shop-card-text' }, h('span', { class: 'shop-card-title' }, home ? 'קניות לבית' : 'קניות אישיות ו־Wish', open.length ? h('span', { class: 'num shop-card-count' }, open.length) : null),
        h('span', { class: 'shop-card-sub' }, open.length ? bdi(`${counts}${names ? ` — ${names}` : ''}`) : 'אין כלום ברשימות')),
      icon('chevron', 16, 'shop-card-chevron')),
    home && openIn(['super']).length ? h('button', { class: 'btn small shop-card-go', onclick: () => { setUi({ 'shop:mode': 'store', [`shop:list:${currentKind()}`]: 'super' }); location.hash = '#/shopping'; } }, icon('cart', 14), 'בסופר') : null);
}

// Keep the screen on while shopping (where supported); released when leaving the mode or the page.
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.route?.view === 'shopping' && state.ui['shop:mode'] === 'store') keepAwake(true); });
window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/shopping')) keepAwake(false); });

export function shoppingView() {
  const list = currentList();
  if (!list) return h('div', { class: 'view' }, h('h1', {}, 'קניות'), h('p', { class: 'muted' }, 'אין רשימות קניות כאן.'));
  // The store mode is for the shared lists you walk a shop with; personal and wish lists are plain lists.
  const storeable = Boolean(list.home);
  const store = storeable && state.ui['shop:mode'] === 'store';
  keepAwake(store);
  const items = state.shopping.items.filter((x) => x.list === list.id);
  const open = items.filter((x) => !x.done);
  const cart = items.filter((x) => x.done);
  const partner = other();
  const placeholder = list.wish ? 'מה היית רוצה לקבל? (אפשר קישור בהערה)' : list.id === 'pharm' ? 'מה צריך מהפארם?' : list.id === 'house' ? 'מדפים, חרסינה, כלי עבודה…' : list.depts ? 'מה צריך? אפשר כמה, עם פסיקים' : 'מה צריך לקנות?';
  const input = h('input', { class: 'qa-input', dataset: { key: `shop-add-${list.id}` }, placeholder, dir: 'auto', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': `הוספה ל${listLabel(list)}` });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && input.value.trim()) { const v = input.value; input.value = ''; add(v, list); } });
  const onList = new Set(items.map((x) => x.text.toLowerCase()));
  const recent = (state.shopping.recent || []).filter((r) => r.list === list.id && !onList.has(r.text.toLowerCase())).slice(0, store ? 0 : 14);
  const here = listsHere();
  const kindKey = `shop:list:${currentKind()}`;
  const listSeg = here.length > 1 ? h('div', { class: 'segmented shop-lists', role: 'tablist', 'aria-label': 'רשימה' }, here.map((l) => { const n = openIn([l.id]).length; return h('button', { class: ['seg', l.id === list.id && 'on'], role: 'tab', 'aria-selected': String(l.id === list.id), onclick: () => setUi({ [kindKey]: l.id }) }, h('span', { class: 'seg-label' }, listLabel(l)), n ? h('span', { class: 'seg-count num' }, n) : null); })) : null;
  const modeSeg = storeable ? h('div', { class: 'segmented', role: 'group', 'aria-label': 'מצב' }, ...[['list', 'רשימה', 'list'], ['store', list.id === 'pharm' ? 'בחנות' : 'בסופר', 'cart']].map(([value, label, iconName]) => h('button', { class: ['seg', (store ? 'store' : 'list') === value && 'on'], 'aria-pressed': String((store ? 'store' : 'list') === value), onclick: () => setUi({ 'shop:mode': value }) }, icon(iconName, 16), h('span', { class: 'seg-label' }, label)))) : null;
  // Groups: departments for the supermarket; "for me / gift ideas" on the wish list; one plain group otherwise.
  let groups;
  if (list.depts) {
    groups = state.depts.map((d) => ({ icon: d.icon, label: d.label, items: open.filter((x) => x.dept === d.id) })).filter((g) => g.items.length);
    const unknown = open.filter((x) => !state.depts.some((d) => d.id === x.dept));
    if (unknown.length) groups.push({ icon: deptOf('other').icon, label: 'אחר', items: unknown });
  } else groups = open.length ? [{ icon: list.icon, label: list.label, items: open, plain: true }] : [];
  const doneLabel = list.wish ? 'קיבלתי' : list.depts ? 'בעגלה' : 'נקנו';
  const finishLabel = list.depts ? `סיימתי קניות (${cart.length})` : `נקה את מה שנקנה (${cart.length})`;
  const empty = { super: ['אין מה לקנות', `אפשר להוסיף כאן, או לכתוב ל־${state.me?.agent || 'סוכן'}: "תוסיף לקניות חלב וביצים".`], pharm: ['אין מה לקנות בפארם', 'שמפו, משחת שיניים, תרופות — מה שנגמר.'], house: ['אין כלום לבית', 'דברים לבית שלא שייכים לסופר או לפארם — מדפים, חרסינה, נורות, כלי עבודה.'], personal: ['אין קניות אישיות', 'מה כל אחד מכם צריך לעצמו. ליד כל פריט רואים של מי הוא.'], wish: ['ה־Wish ריקה', `מה כל אחד מכם היה רוצה לקבל יום אחד. על משאלה של ${partner?.name || 'בן/בת הזוג'} אפשר לסמן בשקט "אני אקנה" — ${partner?.name || 'הוא/היא'} לא רואה את זה.`] }[list.id] || ['אין כלום ברשימה', ''];
  const who = list.wish ? '"אני אקנה" לא מוצג למי שביקש' : list.byline ? 'ליד כל פריט — של מי' : '';
  return h('div', { class: ['view', 'shopping', store && 'in-store'] },
    h('header', { class: 'view-head' },
      h('div', {}, h('h1', {}, store ? (list.id === 'pharm' ? 'בפארם' : 'בסופר') : 'קניות'), h('p', { class: 'view-sub' }, `${list.icon} ${listLabel(list)}${open.length ? ` · ${open.length} ${list.wish ? 'משאלות' : 'לקנות'}` : ''}${who ? ` · ${who}` : ''}`)),
      h('div', { class: 'view-actions' }, modeSeg)),
    listSeg,
    h('div', { class: 'quick-add shop-add' }, icon('plus', 16), input),
    recent.length ? h('div', { class: 'shop-recent' }, h('span', { class: 'muted small' }, 'קנינו לאחרונה:'), recent.map((r) => h('button', { class: 'chip-btn', onclick: () => add(r.text, list) }, '+ ', bdi(r.text)))) : null,
    open.length || cart.length ? null : h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon(list.wish ? 'sparkles' : 'cart', 28)), h('h2', {}, empty[0]), h('p', { class: 'muted' }, empty[1])),
    groups.map((g) => h('section', { class: 'shop-group' },
      g.plain ? null : h('div', { class: 'subhead shop-dept', role: 'heading', 'aria-level': '3' }, h('span', { 'aria-hidden': 'true' }, g.icon), g.label, h('span', { class: 'num' }, g.items.length), g.note ? h('span', { class: 'shop-dept-note' }, g.note) : null),
      h('div', { class: 'shop-rows' }, g.items.map((x) => itemRow(x, store))))),
    cart.length ? h('section', { class: 'shop-group cart' },
      h('div', { class: 'subhead shop-dept', role: 'heading', 'aria-level': '3' }, h('span', { 'aria-hidden': 'true' }, list.depts ? '🧺' : '✓'), doneLabel, h('span', { class: 'num' }, cart.length)),
      h('div', { class: 'shop-rows' }, cart.map((x) => itemRow(x, store)))) : null,
    cart.length ? h('div', { class: 'shop-finish' }, h('button', { class: 'btn primary', onclick: () => finish(list) }, icon('check', 16), finishLabel)) : null);
}
