// Turns the date words an agent hears on WhatsApp into real dates — on the server, in the instance time zone, on
// the configured work week (server/locale.js) — so the agent never has to run `date` or do calendar arithmetic.
// The vocabulary is Hebrew + English.
// Impossible values (31.2, 25:70) are rejected, never rolled over into some other day.
import { addDays, local, zoned } from './time.js';
import { WEEK_END, WEEK_START, WORKDAYS } from './locale.js';

const DAY_NAMES = [
  ['sun', 'sunday', 'ראשון', 'א'], ['mon', 'monday', 'שני', 'ב'], ['tue', 'tuesday', 'שלישי', 'ג'],
  ['wed', 'wednesday', 'רביעי', 'ד'], ['thu', 'thursday', 'חמישי', 'ה'], ['fri', 'friday', 'שישי', 'ו'], ['sat', 'saturday', 'שבת', 'ש'],
];
const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const dowOf = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
export const isWorkday = (date) => WORKDAYS.includes(dowOf(date));
export const nextWorkday = (date) => { let d = addDays(date, 1); while (!isWorkday(d)) d = addDays(d, 1); return d; };
const bad = (message) => Object.assign(new Error(message), { status: 400, code: 'invalid' });
const pad = (n) => String(n).padStart(2, '0');

/** True only for a real calendar day (rejects 2027-02-31, 2026-13-01…). */
export function isRealDate(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
export const isRealTime = (hh, mm) => Number.isInteger(hh) && Number.isInteger(mm) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
export function checkIsoDate(s, name = 'date') {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || !isRealDate(+m[1], +m[2], +m[3])) throw bad(`${name} "${s}" is not a real date (YYYY-MM-DD)`);
  return s;
}

// Hebrew niceties: quotes/geresh, "ב-7:30", "יום ב׳", "בראשון".
const clean = (s) => String(s).trim().toLowerCase().replace(/[״"]/g, '"').replace(/\s+/g, ' ');
function dayIndex(word) {
  const w = word.replace(/^(יום|ביום)\s+/, '').replace(/^ב(?=[א-ת]{2,})/, '').replace(/[׳'"]/g, '').trim();
  return DAY_NAMES.findIndex((names) => names.includes(w));
}

/** Hebrew label for a date relative to today: "היום (ראשון 11.10)", "מחר (שני 12.10)", "יום שלישי 13.10". */
export function heDay(date, now = new Date()) {
  const t = local(now).date;
  const [y, m, d] = date.split('-').map(Number);
  const name = `${HE_DAYS[dowOf(date)]} ${d}.${m}${y !== local(now).y ? `.${y}` : ''}`;
  if (date === t) return `היום (${name})`;
  if (date === addDays(t, 1)) return `מחר (${name})`;
  return `יום ${name}`;
}

/**
 * A date expression → { date: "YYYY-MM-DD" | null, warn }. Accepts:
 * ISO date · today/היום · tomorrow/מחר · מחרתיים · next-workday · a weekday (ראשון…חמישי, sun…thu, יום ב׳ — the coming
 * one, never today) · "<weekday> שאחרי" (the one after that) · "<weekday> אחרי <date>" (first such day after a date) ·
 * next-week/שבוע הבא (= coming Sunday) · end-of-week/סוף השבוע (= Thursday) · +3d / +2w / "עוד 3 ימים" / "בעוד שבועיים" ·
 * DD.MM[.YYYY] (a past DD.MM means next year — flagged in `warn`).
 */
export function resolveDateInfo(expr, now = new Date()) {
  if (expr === null || expr === undefined || expr === '' || expr === 'none' || expr === 'clear') return { date: null, warn: '' };
  const s = clean(expr);
  const t = local(now).date;
  const ok = (date, warn = '') => ({ date, warn });
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return ok(checkIsoDate(s));
  if (['today', 'היום'].includes(s)) return ok(t);
  if (['tomorrow', 'מחר'].includes(s)) return ok(addDays(t, 1));
  if (['day-after-tomorrow', 'מחרתיים'].includes(s)) return ok(addDays(t, 2));
  if (['next-workday', 'workday', 'יום עבודה הבא', 'יום העבודה הבא'].includes(s)) return ok(nextWorkday(t));
  if (['next-week', 'שבוע הבא', 'בשבוע הבא'].includes(s)) { let d = addDays(t, 1); while (dowOf(d) !== WEEK_START) d = addDays(d, 1); return ok(d); }
  if (['end-of-week', 'סוף השבוע', 'סוף שבוע', 'סוף השבוע הזה'].includes(s)) { let d = t; while (dowOf(d) !== WEEK_END) d = addDays(d, 1); return ok(d); }
  let m = s.match(/^(?:\+|(?:ב)?עוד\s+)(\d{1,3})\s*([dw]|days?|weeks?|ימים|יום|שבועות|שבוע)$/);
  if (m) return ok(addDays(t, Number(m[1]) * (/^(w|week|שבוע)/.test(m[2]) ? 7 : 1)));
  if (/^(?:ב)?עוד שבועיים$/.test(s)) return ok(addDays(t, 14));
  if (/^(?:ב)?עוד שבוע$/.test(s)) return ok(addDays(t, 7));
  m = s.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?$/);
  if (m) {
    const d = Number(m[1]); const mo = Number(m[2]);
    let y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : local(now).y;
    let warn = '';
    if (!m[3] && `${y}-${pad(mo)}-${pad(d)}` < t) { y += 1; warn = ` ⚠️ ${d}.${mo} כבר עבר השנה — נקבע ל־${y}`; }
    if (!isRealDate(y, mo, d)) throw bad(`"${expr}" is not a real date${!m[3] ? ` in ${y}` : ''}`);
    return ok(`${y}-${pad(mo)}-${pad(d)}`, warn);
  }
  // "<weekday> אחרי <date>": first such weekday strictly after that date.
  m = s.match(/^(.+?)\s+אחרי\s+(.+)$/);
  if (m && dayIndex(m[1]) >= 0) {
    const base = resolveDateInfo(m[2], now).date;
    const idx = dayIndex(m[1]);
    let d = addDays(base, 1); while (dowOf(d) !== idx) d = addDays(d, 1);
    return ok(d);
  }
  // "ראשון" / "ראשון הבא" / "ראשון הקרוב" = the coming Sunday (never today); "חמישי שאחרי" = the one after that.
  const after = /\s+(שאחרי|שאחריו|after)$/.test(s);
  const idx = dayIndex(s.replace(/^(next|הבא|ה)\s+/, '').replace(/\s+(הבא|הקרוב|next|שאחרי|שאחריו|after)$/, ''));
  if (idx >= 0) {
    let d = addDays(t, 1);
    while (dowOf(d) !== idx) d = addDays(d, 1);
    return ok(after ? addDays(d, 7) : d);
  }
  throw bad(`Unknown date "${expr}". Use YYYY-MM-DD, today, tomorrow, next-workday, a weekday (ראשון…חמישי / sun…thu), "חמישי שאחרי", "חמישי אחרי 18.10", next-week, end-of-week, +3d, or DD.MM`);
}
export const resolveDate = (expr, now = new Date()) => resolveDateInfo(expr, now).date;

const DAYPART = [
  { words: ['בבוקר', 'בוקר', 'morning'], def: '09:00', pm: false },
  { words: ['בצהריים', 'צהריים', 'noon'], def: '12:00', pm: true },
  { words: ['אחר הצהריים', 'אחה"צ', 'אחהצ', 'afternoon'], def: '15:00', pm: true },
  { words: ['בערב', 'ערב', 'evening'], def: '18:00', pm: true },
  { words: ['בלילה', 'לילה', 'night'], def: '21:00', pm: true },
];

/** Relative Hebrew/English durations → minutes: "+90m", "+1h30m", "עוד שעה", "בעוד שעתיים", "עוד חצי שעה", "עוד 20 דקות". */
function relativeMinutes(s) {
  let m = s.match(/^\+\s*(?:(\d{1,3})\s*(?:h|hours?|שעות|שעה))?\s*(?:(\d{1,4})\s*(?:m|min|minutes?|דקות|דק׳?|דק'))?$/i);
  if (m && (m[1] || m[2])) return (Number(m[1]) || 0) * 60 + (Number(m[2]) || 0);
  m = s.match(/^(?:ב)?עוד\s+(.+)$/);
  if (!m) return null;
  const r = m[1].replace(/\s+/g, ' ');
  const words = { 'שעה': 60, 'שעתיים': 120, 'חצי שעה': 30, 'רבע שעה': 15, 'שעה וחצי': 90, 'שעה ורבע': 75, 'שלושת רבעי שעה': 45, 'דקה': 1, 'יומיים': 2880, 'יום': 1440 };
  if (words[r] !== undefined) return words[r];
  m = r.match(/^(\d{1,4})\s*(דקות|דק׳|דק'|דקה|שעות|שעה|ימים)$/);
  if (m) return Number(m[1]) * (/^שע/.test(m[2]) ? 60 : m[2] === 'ימים' ? 1440 : 1);
  m = r.match(/^(\d{1,2})\s*שעות?\s+ו(?:-)?(\d{1,2})\s*דקות$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return null;
}

/**
 * A moment expression → { iso, date, time, label }. Accepts: +90m / "עוד שעה" / "בעוד שעתיים" · full ISO with offset ·
 * "YYYY-MM-DDTHH:MM" (local time) · "HH:MM" (today; tomorrow if already past — flagged) · "<date expr> [ב|בשעה] HH:MM
 * [בבוקר|בערב…]" · "<date expr> בבוקר|בצהריים|בערב" (09:00 / 12:00 / 18:00). With an explicit time, בערב/אחה״צ means
 * PM ("מחר 7:30 בערב" = 19:30) and בבוקר keeps it AM.
 */
export function resolveAt(expr, now = new Date()) {
  if (typeof expr !== 'string' || !expr.trim()) throw bad('Reminder time is required, e.g. "+1h", "עוד שעה", "17:00", "מחר 09:30"');
  let s = clean(expr).replace(/\bat\s+/, '').replace(/\s*ב-\s*(?=\d)/g, ' ').replace(/\s+בשעה\s+/g, ' ').replace(/\s+ב(?=\d{1,2}:\d{2})/g, ' ').replace(/^ב(?=\d{1,2}:\d{2})/, '').replace(/\s+/g, ' ').trim();
  const out = (t, note = '') => {
    const l = local(t); const tl = local(now);
    const label = `${heDay(l.date, now).replace(/^יום /, '')} ${l.time}${note}`;
    if (t <= now.getTime() - 60_000) throw bad(`"${expr}" is in the past (${label}; now ${tl.date} ${tl.time})`);
    return { iso: new Date(t).toISOString(), date: l.date, time: l.time, label };
  };
  const rel = relativeMinutes(s);
  if (rel !== null) { if (rel <= 0 || rel > 60 * 24 * 366) throw bad(`Bad duration "${expr}"`); return out(now.getTime() + rel * 60_000); }
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})t(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    if (!isRealDate(+m[1], +m[2], +m[3]) || !isRealTime(+m[4], +m[5])) throw bad(`"${expr}" is not a real date/time`);
    return out(m[7] ? Date.parse(expr.trim()) : zoned(+m[1], +m[2], +m[3], +m[4], +m[5]));
  }
  // Day part: a description of an explicit time ("7:30 בערב" → 19:30) or, alone, a default time.
  let pm = null;
  for (const part of DAYPART) {
    const w = part.words.find((x) => s === x || s.endsWith(` ${x}`));
    if (!w) continue;
    const rest = s.slice(0, s.length - w.length).trim();
    if (/\d{1,2}(:\d{2})?$/.test(rest)) { pm = part.pm; s = rest; } else s = `${rest} ${part.def}`.trim();
    break;
  }
  m = s.match(/^(?:(.*?)\s+)?(\d{1,2})(?::(\d{2}))?$/);
  if (m && (m[3] !== undefined || pm !== null)) {
    let hh = Number(m[2]); const mm = Number(m[3] || 0);
    if (pm === true && hh < 12) hh += 12;
    if (!isRealTime(hh, mm)) throw bad(`"${expr}" is not a real time`);
    const datePart = (m[1] || '').trim();
    let date = datePart ? resolveDateInfo(datePart, now).date : local(now).date;
    let note = '';
    let t = zoned(...date.split('-').map(Number), hh, mm);
    if (!datePart && t <= now.getTime()) { date = addDays(date, 1); t = zoned(...date.split('-').map(Number), hh, mm); note = ' — השעה כבר עברה היום, נקבע למחר'; }
    return out(t, note);
  }
  throw bad(`Unknown time "${expr}". Use +90m, "עוד שעה", 17:00, "מחר 09:30", "ראשון ב-9:30", "מחר 7:30 בערב", "next-workday בבוקר" or YYYY-MM-DDTHH:MM`);
}

/** The next days with their names — so the agent can map "ביום רביעי" without computing anything. */
export function calendar(now = new Date(), days = 8) {
  const t = local(now).date;
  return Array.from({ length: days }, (_, i) => addDays(t, i)).map((d) => `${d.slice(8)}.${Number(d.slice(5, 7))} ${HE_DAYS[dowOf(d)]}${isWorkday(d) ? '' : ' (לא יום עבודה)'}${d === t ? ' ← היום' : ''}`).join(' · ');
}
