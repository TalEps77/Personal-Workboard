// Calendar conventions of this instance, from the environment:
//   TZ / WORKBOARD_TZ          wall-clock time zone (reminders, "today", the schedule)   default Asia/Jerusalem
//   WORKBOARD_WORKWEEK         work days: "sun-thu" | "mon-fri" | "mon-sat" | "0,1,2,3,4" (0 = Sunday) default sun-thu
//   WORKBOARD_WORK_HOURS       "08:00-17:00" — when the "automatic" context means work     default 08:00-17:00
// "Next week" means the first work day of next week, "end of week" its last work day.
const NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function parseWorkweek(value = 'sun-thu') {
  const v = String(value).trim().toLowerCase();
  let days;
  const range = v.match(/^([a-z]{3})-([a-z]{3})$/);
  if (range && range[1] in NAMES && range[2] in NAMES) {
    days = []; for (let d = NAMES[range[1]]; ; d = (d + 1) % 7) { days.push(d); if (d === NAMES[range[2]]) break; }
  } else if (/^[0-6](,[0-6])*$/.test(v)) days = [...new Set(v.split(',').map(Number))];
  else throw new Error(`WORKBOARD_WORKWEEK must look like "sun-thu", "mon-fri" or "0,1,2,3,4" (got "${value}")`);
  return days;
}
export function parseHours(value = '08:00-17:00') {
  const m = String(value).trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`WORKBOARD_WORK_HOURS must look like "08:00-17:00" (got "${value}")`);
  const pad = (n) => String(n).padStart(2, '0');
  return { start: `${pad(+m[1])}:${m[2]}`, end: `${pad(+m[3])}:${m[4]}` };
}

export const WORKDAYS = parseWorkweek(process.env.WORKBOARD_WORKWEEK || 'sun-thu');
export const WEEK_START = WORKDAYS[0];
export const WEEK_END = WORKDAYS[WORKDAYS.length - 1];
export const WORK_HOURS = parseHours(process.env.WORKBOARD_WORK_HOURS || '08:00-17:00');
/** What the browser needs to agree with the server. */
export const localeInfo = (tz) => ({ tz, workdays: WORKDAYS, workHours: WORK_HOURS });
