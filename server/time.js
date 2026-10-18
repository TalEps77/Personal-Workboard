// Wall-clock helpers for the instance time zone (TZ / WORKBOARD_TZ). Reminders keep their local time across DST changes.
import { WORKDAYS } from './locale.js';

export const TZ = process.env.WORKBOARD_TZ || process.env.TZ || 'Asia/Jerusalem';

const partsFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23' });
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function local(date = new Date()) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second, dow: DOW[p.weekday], date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** UTC ms for a wall-clock time in TZ. */
export function zoned(y, m, d, hh = 0, mm = 0) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offsetAt = (t) => { const l = local(t); return Date.UTC(l.y, l.m - 1, l.d, l.hh, l.mm, l.ss) - Math.floor(t / 1000) * 1000; };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return t;
}

export const today = (now = new Date()) => local(now).date;

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

const minutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

export function inQuietHours(quiet, now = new Date()) {
  if (!quiet?.start || !quiet?.end) return false;
  const l = local(now); const cur = l.hh * 60 + l.mm; const s = minutes(quiet.start); const e = minutes(quiet.end);
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}

/** Next moment quiet hours end, as ISO. */
export function quietEnd(quiet, now = new Date()) {
  const l = local(now); const [h, m] = quiet.end.split(':').map(Number);
  let t = zoned(l.y, l.m, l.d, h, m);
  if (t <= now.getTime()) { const n = addDays(l.date, 1).split('-').map(Number); t = zoned(n[0], n[1], n[2], h, m); }
  return new Date(t).toISOString();
}

/**
 * Next occurrence of a repeating reminder strictly after `after`. Day-of-month and time come from the reminder's
 * wall-clock `anchor` ("YYYY-MM-DDTHH:MM"), so the 31st doesn't drift to the 28th and 02:30 survives DST gaps.
 */
export function nextOccurrence(atIso, repeat, after = new Date(), anchor = null) {
  const cur = local(atIso);
  const [aDate, aTime] = (anchor || `${cur.date}T${cur.time}`).split('T');
  const [hh, mm] = aTime.split(':').map(Number);
  const anchorDay = Number(aDate.slice(8, 10));
  let date = cur.date;
  for (let guard = 0; guard < 4000; guard += 1) {
    if (repeat === 'monthly') {
      const [y, m] = date.split('-').map(Number);
      const ny = m === 12 ? y + 1 : y; const nm = m === 12 ? 1 : m + 1;
      const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
      date = `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(anchorDay, last)).padStart(2, '0')}`;
    } else {
      date = addDays(date, repeat === 'weekly' ? 7 : 1);
    }
    const [y, m, d] = date.split('-').map(Number);
    const t = zoned(y, m, d, hh, mm);
    // "weekdays" = the instance's work days (WORKBOARD_WORKWEEK).
    if (repeat === 'weekdays' && !WORKDAYS.includes(local(t).dow)) continue;
    if (t > after.getTime()) return new Date(t).toISOString();
  }
  throw new Error('Could not compute next occurrence');
}

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export function heDate(dateStr, now = new Date()) {
  if (!dateStr) return '';
  const t = today(now);
  if (dateStr === t) return 'היום';
  if (dateStr === addDays(t, 1)) return 'מחר';
  if (dateStr === addDays(t, -1)) return 'אתמול';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `יום ${HE_DAYS[dow]} ${d}.${m}`;
}
export function heDateTime(iso, now = new Date()) {
  const l = local(iso);
  return `${heDate(l.date, now)} ${l.time}`;
}
