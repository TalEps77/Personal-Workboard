// Screenshots for design review (not a test). SUITE=shots SHOTS=/tmp/dir tests/browser/run.sh
import { createRequire } from 'node:module';
const { chromium } = createRequire(`${process.env.PW_DIR || '/tmp/pw'}/package.json`)('playwright');
const base = process.env.BASE; const out = process.env.SHOTS || '/tmp/wbshots';
const api = async (path, method = 'GET', body, user = 'avi') => (await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-user': user }, body: body && JSON.stringify(body) })).json();
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
for (const t of [
  { title: 'מצגת ללקוח', space: 'work', when: day(0), status: 'doing' }, { title: 'לחזור לספק', space: 'work', deadline: day(1) },
  { title: 'לקנות מתנה לאמא', space: 'avi-life', when: day(0) }, { title: 'לקבוע תור לרופא', space: 'avi-life', when: day(2) },
  { title: 'להזמין אינסטלטור', space: 'home', assignee: 'avi', when: day(0) }, { title: 'לשלם ארנונה', space: 'home', assignee: 'maya', when: day(1) },
  { title: 'לתקן את הברז', space: 'home', assignee: 'both' },
]) await api('/api/tasks', 'POST', t);
await api('/api/shopping', 'POST', { items: ['עגבניות', 'מלפפונים', 'חלב', 'ביצים', 'לחם', 'נייר טואלט', 'שמפו', 'אורז', 'קפה'].map((text) => ({ text })) });
await api('/api/shopping', 'POST', { items: [{ text: 'שמפו', list: 'pharm' }, { text: 'משחת שיניים', list: 'pharm' }, { text: 'נעלי ריצה', list: 'personal' }, { text: 'אוזניות', list: 'wish' }, { text: 'מדפים לסלון', list: 'house' }] });
await api('/api/shopping', 'POST', { items: [{ text: 'שרשרת', list: 'wish', note: 'כסף, עדינה' }] }, 'maya');
// Fixed daytime schedule; the pages below are frozen at 10:30 so the screenshots read like a normal morning.
for (const [t, sp, k, start, end] of [['ישיבת צוות', 'work', 'meeting', '11:00', '11:45'], ['עבודה על המצגת', 'work', 'work', '13:00', '14:30'], ['רופא שיניים', 'avi-life', 'meeting', '16:30', '17:00'], ['טכנאי מזגנים', 'home', 'meeting', '18:00', '19:00']]) await api('/api/schedule', 'POST', { title: t, date: day(0), start, end, kind: k, space: sp, ...(sp === 'home' && { owner: 'home' }) });
const b = await chromium.launch();
for (const scheme of ['light', 'dark']) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', colorScheme: scheme, extraHTTPHeaders: { 'x-user': 'avi' } });
  const pg = await ctx.newPage();
  const morning = new Date(); morning.setHours(10, 30, 0, 0);
  await pg.clock.setFixedTime(morning);
  const shot = async (hash, name, prep) => { await pg.goto(`${base}/${hash}`); await pg.waitForTimeout(900); if (prep) await prep(); await pg.screenshot({ path: `${out}/${name}-${scheme}.png` }); };
  const ctxShot = async (space, hash, name, prep) => { await pg.goto(`${base}/`); await pg.evaluate((sp) => { const ui = JSON.parse(localStorage.getItem('wb-ui') || '{}'); ui.space = sp; localStorage.setItem('wb-ui', JSON.stringify(ui)); }, space); await pg.reload(); await shot(hash, name, prep); };
  await ctxShot('work', '#/today', 'today-work');
  await ctxShot('home', '#/today', 'today-home');
  await ctxShot('avi-life', '#/today', 'today-personal');
  await ctxShot('all', '#/today', 'today-all');
  await ctxShot('avi-life', '#/shopping', 'wish', async () => { await pg.locator('.shop-lists .seg', { hasText: 'Wish' }).click(); await pg.waitForTimeout(300); });
  await ctxShot('home', '#/timeline', 'timeline-home');
  await ctxShot('home', '#/shopping', 'shopping', async () => {
    // Half-swipe the second row to show the actions.
    const row = pg.locator('.shop-row').nth(1); const box = await row.boundingBox();
    const cdp = await ctx.newCDPSession(pg);
    const y = box.y + box.height / 2; let x = box.x + box.width * 0.8;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 0; i < 8; i += 1) { x -= 12; await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); await pg.waitForTimeout(16); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await pg.waitForTimeout(500);
  });
  await ctxShot('home', '#/today', 'ctx-sheet', async () => { await pg.click('.ctx-chip'); await pg.waitForTimeout(300); });
  await ctx.close();
}
// Pairing screen: a fresh, unauthenticated look (dev mode is always signed in, so render it by stubbing the status).
for (const scheme of ['light', 'dark']) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: 'he-IL', colorScheme: scheme });
  const pg = await ctx.newPage();
  await pg.route('**/api/auth/status', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ authenticated: false, canSendCode: true, users: [{ id: 'avi', name: 'אבי' }, { id: 'maya', name: 'מאיה' }] }) }));
  await pg.route('**/api/auth/request-code', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ sent: true }) }));
  await pg.goto(`${base}/#/today`); await pg.waitForTimeout(900);
  await pg.screenshot({ path: `${out}/pair-${scheme}.png` });
  await pg.click('.pair-person >> nth=1'); await pg.waitForTimeout(500);
  await pg.screenshot({ path: `${out}/pair2-${scheme}.png` });
  await ctx.close();
}
await b.close();
console.log('shots done');
