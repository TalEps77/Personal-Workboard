// Shopping lists: shared at home (supermarket, pharmacy) and private (personal purchases, wish list). The supermarket is built for the store: every item has a department, so in "super mode"
// the list reads in the order you walk the store. Departments are guessed from the words (and learned: once someone
// moves "טחינה" to מזווה, it stays there). Ticked items stay until "סיימתי קניות", then go to the recent list so
// regulars come back with one tap.
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeAtomic } from './fs-util.js';

export const DEPTS = [
  { id: 'produce', label: 'פירות וירקות', icon: '🥬', words: ['עגבני', 'מלפפון', 'מלפפונים', 'בצל', 'שום', 'תפוח', 'תפוחי', 'בננ', 'גזר', 'פלפל', 'חסה', 'כרוב', 'תפו״א', 'תפוא', 'בטטה', 'קישוא', 'חציל', 'לימון', 'אבוקדו', 'תות', 'ענב', 'אגס', 'אפרסק', 'מנגו', 'אבטיח', 'מלון', 'פטרוזיליה', 'כוסברה', 'שמיר', 'נענע', 'פטריות', 'ברוקולי', 'כרובית', 'תירס', 'סלק', 'קולרבי', 'תפוז', 'קלמנטינ', 'אננס', 'קיווי', 'רימון', 'צנונית', 'ג׳ינג׳ר', 'זנגביל', 'בזיליקום', 'סלרי', 'ירקות', 'פירות', 'עירית', 'ארוגולה', 'תרד'] },
  { id: 'dairy', label: 'חלב, גבינות וביצים', icon: '🧀', words: ['חלב', 'גבינ', 'קוטג', 'יוגורט', 'שמנת', 'חמאה', 'ביצים', 'ביצה', 'לבנה', 'מעדן', 'משקה סויה', 'חלב שקדים', 'בולגרית', 'צפתית', 'מוצרלה', 'פרמזן', 'צהובה', 'שוקו', 'אשל', 'גיל', 'דנונה', 'מילקי', 'קשקבל', 'ריקוטה', 'מסקרפונה'] },
  { id: 'bakery', label: 'לחם ומאפים', icon: '🥖', words: ['לחם', 'פיתות', 'פיתה', 'לחמני', 'חלה', 'חלות', 'בגט', 'טורטיה', 'קרואסון', 'מאפה', 'עוגה', 'עוגיות', 'פרוס', 'לאפה', 'בורקס'] },
  { id: 'meat', label: 'בשר, עוף ודגים', icon: '🍗', words: ['עוף', 'חזה', 'שניצל', 'פרגית', 'כרעיים', 'בשר', 'טחון', 'סטייק', 'אנטריקוט', 'קבב', 'נקניק', 'נקניקיות', 'הודו', 'כבד', 'דג', 'דגים', 'סלמון', 'טונה טרייה', 'אמנון', 'לברק', 'פילה', 'המבורגר', 'שוקיים', 'כנפיים', 'פסטרמה'] },
  { id: 'deli', label: 'מעדנייה וסלטים', icon: '🥙', words: ['חומוס', 'טחינה מוכנה', 'סלט', 'מטבוחה', 'חצילים במיונז', 'זיתים', 'מלפפון חמוץ', 'חמוצים', 'סביח'] },
  { id: 'frozen', label: 'קפואים', icon: '🧊', words: ['קפוא', 'קפואים', 'גלידה', 'שלגון', 'אפונה', 'שעועית ירוקה', 'פיצה קפואה', 'בצק', 'בורקס קפוא', 'ירקות קפואים', 'קרטיב', 'מלוואח', 'ג׳חנון'] },
  { id: 'pantry', label: 'מזווה ושימורים', icon: '🥫', words: ['אורז', 'פסטה', 'ספגטי', 'קמח', 'סוכר', 'מלח', 'שמן', 'רסק', 'שימורי', 'טונה', 'תירס שימורים', 'עדשים', 'חומוס יבש', 'קוסקוס', 'בורגול', 'קינואה', 'פתיתים', 'שקדים', 'אגוזים', 'צימוקים', 'דבש', 'ריבה', 'שוקולד ממרח', 'נוטלה', 'חמאת בוטנים', 'קורנפלקס', 'דגני', 'גרנולה', 'שיבולת', 'קוואקר', 'טחינה', 'מרק', 'אבקת', 'שמרים', 'קקאו', 'פירורי לחם', 'פירורים', 'חומץ', 'רוטב', 'קטשופ', 'מיונז', 'חרדל', 'סילאן', 'שעועית', 'אפונה יבשה'] },
  { id: 'spices', label: 'תבלינים ואפייה', icon: '🧂', words: ['פפריקה', 'כמון', 'כורכום', 'פלפל שחור', 'קינמון', 'אורגנו', 'תבלין', 'וניל', 'אבקת אפייה', 'סודה לשתייה', 'זעתר', 'הל', 'ציפורן', 'אגוז מוסקט'] },
  { id: 'snacks', label: 'חטיפים ומתוקים', icon: '🍫', words: ['במבה', 'ביסלי', 'חטיף', 'שוקולד', 'ופל', 'סוכריות', 'מסטיק', 'צ׳יפס', 'פופקורן', 'בייגלה', 'קרקר', 'פריכיות', 'עוגיות', 'תפוצ׳יפס', 'דובונים'] },
  { id: 'drinks', label: 'משקאות', icon: '🥤', words: ['מים', 'סודה', 'קולה', 'מיץ', 'בירה', 'יין', 'פטל', 'שתייה', 'משקה', 'קפה', 'תה', 'נס', 'קפסולות', 'ספרייט', 'פאנטה', 'תפוזים טבעי', 'וודקה', 'ערק'] },
  { id: 'cleaning', label: 'ניקיון וכביסה', icon: '🧽', words: ['אקונומיקה', 'סבון כלים', 'נוזל כלים', 'טבליות', 'מדיח', 'אבקת כביסה', 'ג׳ל כביסה', 'מרכך', 'ספוג', 'סקוטש', 'שקיות זבל', 'מגבונים', 'נייר טואלט', 'נייר סופג', 'מגבות נייר', 'ניקוי', 'מטהר', 'כלור', 'סנו', 'מנקה', 'אלומיניום', 'נייר כסף', 'ניילון נצמד', 'נייר אפייה', 'שקיות', 'כפפות'] },
  { id: 'pharm', label: 'פארם והיגיינה', icon: '🧴', words: ['שמפו', 'מרכך שיער', 'סבון', 'משחת שיניים', 'מברשת שיניים', 'דאודורנט', 'קרם', 'תחבושות', 'טמפונים', 'סכין גילוח', 'קצף גילוח', 'פלסטרים', 'אקמול', 'נורופן', 'ויטמין', 'קיסמי אוזניים', 'צמר גפן', 'חוט דנטלי', 'מי פה', 'קרם הגנה'] },
  { id: 'baby', label: 'תינוקות', icon: '🍼', words: ['חיתולים', 'מטרנה', 'סימילאק', 'מגבונים לתינוק', 'מוצץ', 'בקבוק לתינוק', 'דייסה'] },
  { id: 'home', label: 'בית ושונות', icon: '🏠', words: ['סוללות', 'נורה', 'נרות', 'צלחות חד', 'כוסות חד', 'סכו״ם חד', 'מפיות', 'גפרורים', 'מצית', 'פחם', 'חד פעמי'] },
  { id: 'other', label: 'אחר', icon: '🛒', words: [] },
];
const DEPT_IDS = new Set(DEPTS.map((d) => d.id));
const bad = (message) => Object.assign(new Error(message), { status: 400, code: 'invalid' });
const notFound = (message) => Object.assign(new Error(message), { status: 404, code: 'not_found' });
export const normText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const key = (s) => normText(s).toLowerCase().replace(/[׳'"`]/g, '');

/** Best department for an item: what was learned for these exact words, else the longest keyword found. */
export function guessDept(text, learned = {}) {
  const k = key(text);
  if (learned[k]) return learned[k];
  // Single keywords match the start of a word ("עגבני" → עגבניות שרי), so short ones like "מים" don't hit "חמים".
  const words = k.split(/[\s,.\-–/]+/).flatMap((w) => (/^[הו]./.test(w) ? [w, w.slice(1)] : [w]));
  const hits = (ww) => (ww.includes(' ') ? k.includes(ww) : words.some((w) => w.startsWith(ww)));
  let best = null; let len = 0;
  for (const d of DEPTS) for (const w of d.words) { const ww = key(w); if (ww.length > len && hits(ww)) { best = d.id; len = ww.length; } }
  return best || 'other';
}

/**
 * The household's lists, all shared by the people who share the home: supermarket (by department), pharmacy, general
 * things for the house (shelves, tiles — nothing that fits a shop), personal purchases and wishes. On the last two
 * every item shows who added it; a wish can be quietly claimed ("אני אקנה") and the one who wished never sees that.
 */
export function shoppingLists() {
  return [
    { id: 'super', label: 'סופר', icon: '🛒', home: true, depts: true },
    { id: 'pharm', label: 'פארם', icon: '🧴', home: true },
    { id: 'house', label: 'לבית', icon: '🛠️', home: true },
    { id: 'personal', label: 'אישי', icon: '🛍️', byline: true },
    { id: 'wish', label: 'Wish', icon: '🎁', byline: true, wish: true },
  ];
}
// Lists from before they were merged (one per person) fold into the shared ones.
const legacyList = (id) => (!id ? 'super' : id.startsWith('personal-') ? 'personal' : id.startsWith('wish-') ? 'wish' : id);

export function createShoppingStore(root, { lock, onChange = () => {} }) {
  const path = join(root, 'data', 'shopping.json');
  const LISTS = shoppingLists();
  const listOf = (id) => LISTS.find((l) => l.id === id) || null;
  const read = async () => { try { const d = JSON.parse(await readFile(path, 'utf8')); return { items: (d.items || []).map((x) => ({ ...x, list: legacyList(x.list) })), learned: d.learned || {}, recent: (d.recent || []).map((x) => ({ ...x, list: legacyList(x.list) })) }; } catch { return { items: [], learned: {}, recent: [] }; } };
  const save = (d) => writeAtomic(path, JSON.stringify(d, null, 2));
  const announce = (lists) => onChange({ type: 'shopping', lists: [...new Set(lists)] });
  const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  // `can(listId)`: whether the caller may see that list (null = everything; maintenance).
  const mutate = (fn) => lock(async () => { const d = await read(); const touched = []; const result = await fn(d, touched); await save(d); announce(touched); return result; });
  const visible = (can) => (x) => !can || can(x.list);
  const check = (can, item) => { if (!item || (can && !can(item.list))) throw notFound('Item not found'); return item; };
  const checkList = (can, id) => { const l = listOf(id); if (!l || (can && !can(id))) throw bad(`Unknown list "${id}"`); return l; };

  return {
    DEPTS,
    lists: LISTS,
    listOf,
    /** `can` = may read the list; `viewer` = who is asking (an owner never sees who is buying them a wish). */
    async get(can = null, viewer = null) {
      const d = await read();
      const hide = (x) => { if (!listOf(x.list)?.wish || !viewer || x.by !== viewer) return x; const { claimed_by, ...rest } = x; return rest; };
      return { lists: LISTS.filter((l) => !can || can(l.id)), items: d.items.filter(visible(can)).map(hide), recent: d.recent.filter(visible(can)).slice(0, 80) };
    },

    /** "I'll buy this" on someone else's wish (or take it back). Never on your own list. */
    claim(id, user, on, { can = null } = {}) {
      return mutate((d, touched) => {
        const item = check(can, d.items.find((x) => x.id === id));
        const l = listOf(item.list);
        if (!l.wish || (item.by && item.by === user)) throw bad('Only someone else\'s wish can be claimed');
        if (on && item.claimed_by && item.claimed_by !== user) throw Object.assign(new Error('Someone already took this one'), { status: 409, code: 'conflict' });
        item.claimed_by = on ? user : null;
        touched.push(item.list);
        const { claimed_by, ...rest } = item;
        return { ...rest, claimed_by: item.claimed_by };
      });
    },

    /** Adds items; an item already on that list (same words) is updated instead of duplicated. */
    add(inputs, { user = null, can = null, list: defaultList = 'super' } = {}) {
      return mutate((d, touched) => inputs.map((input) => {
        const listId = (typeof input === 'object' && input.list) || defaultList;
        const list = checkList(can, listId);
        touched.push(listId);
        const text = normText(typeof input === 'string' ? input : input.text).slice(0, 120);
        if (!text) throw bad('item text is required');
        const given = input.dept && DEPT_IDS.has(input.dept) ? input.dept : null;
        const dept = list.depts ? given || guessDept(text, d.learned) : null;
        if (list.depts && given) d.learned[key(text)] = given;
        const existing = d.items.find((x) => x.list === listId && key(x.text) === key(text));
        const extra = { ...(input.qty !== undefined && { qty: normText(input.qty).slice(0, 30) }), ...(input.note !== undefined && { note: normText(input.note).slice(0, 200) }) };
        if (existing) {
          const wasDone = existing.done;
          Object.assign(existing, { done: false, done_at: null, ...extra, ...(given && list.depts && { dept }) });
          return { item: existing, status: wasDone ? 'reopened' : 'exists' };
        }
        const item = { id: newId(), list: listId, text, qty: '', note: '', dept, done: false, by: user, added_at: new Date().toISOString(), done_at: null, ...extra };
        d.items.push(item);
        d.recent = d.recent.filter((r) => !(r.list === listId && key(r.text) === key(text)));
        return { item, status: 'added' };
      }));
    },

    /** patch: text, qty, note, dept, done, list (move to another list). Moving to a department teaches it. */
    update(id, patch, { can = null } = {}) {
      return mutate((d, touched) => {
        const item = check(can, d.items.find((x) => x.id === id));
        touched.push(item.list);
        if (patch.list !== undefined && patch.list !== item.list) { const to = checkList(can, patch.list); item.list = to.id; item.dept = to.depts ? guessDept(item.text, d.learned) : null; touched.push(to.id); }
        const list = listOf(item.list);
        if (patch.text !== undefined) { item.text = normText(patch.text).slice(0, 120); if (!item.text) throw bad('item text is required'); }
        if (patch.qty !== undefined) item.qty = normText(patch.qty).slice(0, 30);
        if (patch.note !== undefined) item.note = normText(patch.note).slice(0, 200);
        if (patch.dept !== undefined && list.depts) { if (!DEPT_IDS.has(patch.dept)) throw bad(`dept must be one of ${[...DEPT_IDS].join(', ')}`); item.dept = patch.dept; d.learned[key(item.text)] = patch.dept; }
        if (patch.done !== undefined) { item.done = Boolean(patch.done); item.done_at = item.done ? new Date().toISOString() : null; }
        return item;
      });
    },

    remove(ids, { can = null } = {}) {
      return mutate((d, touched) => {
        const set = new Set([].concat(ids));
        const removed = d.items.filter((x) => set.has(x.id) && visible(can)(x));
        removed.forEach((x) => touched.push(x.list));
        d.items = d.items.filter((x) => !removed.includes(x));
        return removed;
      });
    },

    /** "סיימתי קניות" on one list: ticked items leave it and go to its recent list (for one-tap re-adding). */
    finish(listId = 'super', { can = null } = {}) {
      return mutate((d, touched) => {
        checkList(can, listId);
        touched.push(listId);
        const done = d.items.filter((x) => x.list === listId && x.done);
        d.items = d.items.filter((x) => !done.includes(x));
        d.recent = [...done.map(({ text, dept, list }) => ({ text, dept, list })), ...d.recent.filter((r) => !done.some((x) => x.list === r.list && key(x.text) === key(r.text)))].slice(0, 200);
        return done;
      });
    },

    /** Puts items back exactly as they were (undo of remove / finish). */
    restore(items, { can = null } = {}) {
      return mutate((d, touched) => {
        const ok = items.filter((it) => it && typeof it.id === 'string' && listOf(it.list || 'super') && (!can || can(it.list || 'super')));
        for (const it of ok) { touched.push(it.list || 'super'); if (!d.items.some((x) => x.id === it.id)) d.items.push({ ...it, list: it.list || 'super' }); }
        d.recent = d.recent.filter((r) => !ok.some((x) => (x.list || 'super') === r.list && key(x.text) === key(r.text)));
        return ok;
      });
    },
  };
}
