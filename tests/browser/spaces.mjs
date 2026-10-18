// Two people on one board: spaces, the shared home, and the shopping list. Run: SUITE=spaces tests/browser/run.sh
import { createRequire } from 'node:module';

const { chromium } = createRequire(`${process.env.PW_DIR || '/tmp/pw'}/package.json`)('playwright');
const base = process.env.BASE || 'http://127.0.0.1:4199';
const api = async (path, method = 'GET', body, user = 'avi', actor) => (await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-user': user, ...(actor && { 'x-actor': actor }) }, body: body && JSON.stringify(body) })).json();
const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? '✅' : '❌'} ${name}${extra ? ` ${extra}` : ''}`); };
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const shots = process.env.SHOTS || null;

// ---- seed ----
await api('/api/tasks', 'POST', { title: 'מצגת ללקוח', space: 'work', when: day(0) });
await api('/api/tasks', 'POST', { title: 'לקנות מתנה לאמא', space: 'avi-life', when: day(0) });
await api('/api/tasks', 'POST', { title: 'לשלם ארנונה', space: 'home', assignee: 'maya', when: day(0) });
await api('/api/tasks', 'POST', { title: 'להזמין אינסטלטור', space: 'home', assignee: 'avi', when: day(0) });
await api('/api/tasks', 'POST', { title: 'לקבוע תור לשיננית', space: 'maya-life', when: day(0) }, 'maya');
await api('/api/shopping', 'POST', { items: [{ text: 'עגבניות' }, { text: 'זעתר' }] }, 'maya');

const browser = await chromium.launch();
const errors = [];
process.on('uncaughtException', (e) => { console.log(results.join('\n')); console.log('CRASH', e.message, '\n', errors.join('\n')); process.exit(1); });
const phone = async (user) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', extraHTTPHeaders: { 'x-user': user }, colorScheme: process.env.SCHEME || 'light' });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errors.push(`${user}: ${e.message}`));
  return { ctx, pg };
};

// ================= her phone =================
const { pg: her } = await phone('maya');
// Start in "הכל" (the default is automatic: work in work hours) so the first checks don't depend on the clock.
await her.goto(`${base}/`); await her.evaluate(() => localStorage.setItem('wb-ui', JSON.stringify({ space: 'all' })));
await her.reload(); await her.goto(`${base}/#/today`); await her.waitForSelector('.large-title'); await her.waitForTimeout(600);
// The task sections (the activity feed may mention shared-home changes by anyone — that's fine).
const herToday = (await her.locator('.view-host .group, .view-host .day-card').allInnerTexts()).join('\n');
check('her Today: the shared task on her', herToday.includes('לשלם ארנונה'));
check('her Today: her own personal task', herToday.includes('לקבוע תור לשיננית'));
check('her Today: nothing of Avi\'s (work, personal, home task on him)', !/מצגת ללקוח|מתנה לאמא|אינסטלטור/.test(herToday), (herToday.match(/.{0,60}(מצגת ללקוח|מתנה לאמא|אינסטלטור).{0,60}/s) || [''])[0].replace(/\s+/g, ' '));
const herCheck = await her.locator('.row .check').first().getAttribute('aria-label');
check('her app speaks to her in the feminine', /סמני/.test(herCheck || ''), herCheck);
const tabsOf = async (pg) => (await pg.locator('.mobile-nav .mnav span:not(.mnav-count)').allInnerTexts()).join('|');
check('הכל: four tabs, projects last', (await tabsOf(her)) === 'היום|יומן|משימות|פרויקטים', await tabsOf(her));
const pick = async (pg, label) => { await pg.click('.ctx-chip'); await pg.waitForSelector('.ctx-sheet'); await pg.locator('.ctx-row', { hasText: label }).first().click(); await pg.waitForTimeout(400); };
await her.click('.ctx-chip'); await her.waitForSelector('.ctx-sheet');
const rows = (await her.locator('.ctx-row .ctx-row-label').allInnerTexts()).join('|');
check('context sheet: בית · עבודה · אישי · הכל · אוטומטי', rows === 'בית|עבודה|אישי|הכל|אוטומטי', rows);
await her.keyboard.press('Escape'); await her.locator('.ctx-host').evaluate((el) => el.remove()).catch(() => {});
await pick(her, 'בית');
check('בית: the shopping list becomes the fourth tab', (await tabsOf(her)) === 'היום|יומן|משימות|קניות', await tabsOf(her));
check('בית: the app takes the home colour', await her.evaluate(() => document.body.dataset.ctx) === 'home');
check('בית: Today shows the shopping card', await her.locator('.shop-card').count() === 1);
check('בית: Today shows what is on Avi', (await her.locator('.view-host').innerText()).includes('על אבי'));
await pick(her, 'עבודה');
check('עבודה: no shopping anywhere', (await tabsOf(her)) === 'היום|יומן|משימות|פרויקטים' && await her.locator('.shop-card').count() === 0);
await pick(her, 'הכל');
await her.goto(`${base}/#/all`); await her.waitForTimeout(500);
check('her list shows the plumber task too (shared, on Avi) but not Avi\'s work', (await her.locator('.view-host').innerText()).includes('אינסטלטור') && !(await her.locator('.view-host').innerText()).includes('מצגת ללקוח'));
await pick(her, 'אישי');
const personal = await her.locator('.view-host').innerText();
check('switch to אישי filters the list', personal.includes('שיננית') && !personal.includes('ארנונה'));
await pick(her, 'הכל');
check('row chip marks a home task "בית · על אבי"', (await her.locator('.row', { hasText: 'אינסטלטור' }).innerText()).includes('על אבי'));

// Quick add while on בית lands in the home space, on her.
await pick(her, 'בית');
await her.goto(`${base}/#/today`); await her.waitForTimeout(300);
await her.locator('.dock-add').click(); await her.waitForSelector('.palette-input');
await her.fill('.palette-input', 'להחליף נורה במרפסת'); await her.keyboard.press('Enter'); await her.waitForTimeout(700);
const bulb = (await api(`/api/tasks?q=${encodeURIComponent('נורה')}`, 'GET', undefined, 'maya')).items[0];
check('new task on בית → home space', bulb?.space === 'home', bulb?.space);
check('…and the sheet offers "על מי"', await her.locator('.drawer .prop', { hasText: 'על מי' }).count() > 0);
await her.goto(`${base}/#/today`); await her.waitForTimeout(300);

// ---- shopping ----
await her.goto(`${base}/#/shopping`); await her.waitForSelector('.shopping');
await her.fill('.shopping .qa-input', 'חלב, 2 ביצים, נייר טואלט'); await her.keyboard.press('Enter'); await her.waitForTimeout(700);
const depts = await her.locator('.shop-dept').allInnerTexts();
check('items grouped by department', depts.some((d) => d.includes('פירות וירקות')) && depts.some((d) => d.includes('חלב')) && depts.some((d) => d.includes('ניקיון')), depts.map((d) => d.replace(/\s+/g, ' ')).join(' | '));
check('"2 ביצים" → quantity 2', (await her.locator('.shop-row', { hasText: 'ביצים' }).innerText()).includes('2'));
await her.locator('.segmented .seg', { hasText: 'בסופר' }).click(); await her.waitForTimeout(300);
check('store mode: big rows', await her.locator('.in-store .shop-row.big').count() >= 4);
if (shots) await her.screenshot({ path: `${shots}/shop-store-${process.env.SCHEME || 'light'}.png` });
await her.locator('.shop-row', { hasText: 'חלב' }).click(); await her.locator('.shop-row', { hasText: 'עגבניות' }).click(); await her.waitForTimeout(500);
check('ticked items move to the cart', (await her.locator('.shop-group.cart').innerText()).includes('חלב'));
if (shots) await her.screenshot({ path: `${shots}/shop-cart-${process.env.SCHEME || 'light'}.png`, fullPage: true });
await her.locator('.shop-finish .btn').click(); await her.waitForTimeout(700);
let list = await api('/api/shopping', 'GET', undefined, 'maya');
check('"סיימתי קניות" clears the cart', !list.items.some((x) => x.text === 'חלב') && list.items.some((x) => x.text === 'ביצים'));
await her.click('.toast-action'); await her.waitForTimeout(700);
list = await api('/api/shopping', 'GET', undefined, 'maya');
check('…and undo brings them back', list.items.some((x) => x.text === 'חלב'));
// Move a department from the item menu: remembered next time.
await her.locator('.segmented .seg', { hasText: 'רשימה' }).click(); await her.waitForTimeout(300);
await her.locator('.shop-row', { hasText: 'זעתר' }).locator('.row-menu').click(); await her.waitForSelector('.shop-sheet');
await her.locator('.shop-sheet .chip-btn', { hasText: 'מעדנייה' }).click(); await her.waitForTimeout(600);
// Swipe left on a row → "הסר"; a long swipe removes it (undo in the toast).
const swipe = async (pg, locator, dist) => { const box = await locator.boundingBox(); const cdp = await pg.context().newCDPSession(pg); const y = box.y + box.height / 2; let x = box.x + box.width * 0.85; await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); const steps = 12; for (let i = 0; i < steps; i += 1) { x -= dist / steps; await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); await pg.waitForTimeout(16); } await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await pg.waitForTimeout(600); };
await swipe(her, her.locator('.shop-row', { hasText: 'ביצים' }), 90);
check('swipe reveals "הסר"', await her.locator('.shop-swipe.open-lead', { hasText: 'ביצים' }).count() === 1);
await her.locator('.shop-swipe.open-lead .swipe-btn', { hasText: 'הסר' }).click(); await her.waitForTimeout(600);
check('…and tapping it removes the item', !(await api('/api/shopping', 'GET', undefined, 'maya')).items.some((x) => x.text === 'ביצים'));
await her.click('.toast-action'); await her.waitForTimeout(600);
await her.waitForTimeout(800);
await swipe(her, her.locator('.shop-row', { hasText: 'נייר טואלט' }), 300);
check('a long swipe removes at once', !(await api('/api/shopping', 'GET', undefined, 'maya')).items.some((x) => x.text === 'נייר טואלט'));
check('moving a department sticks', (await api('/api/shopping', 'GET', undefined, 'maya')).items.find((x) => x.text === 'זעתר')?.dept === 'deli');

// ---- personal context: her private lists, gift ideas stay hers ----
await pick(her, 'אישי');
check('אישי: shopping is the fourth tab', (await tabsOf(her)) === 'היום|יומן|משימות|קניות', await tabsOf(her));
await her.goto(`${base}/#/shopping`); await her.waitForSelector('.shopping');
await api('/api/shopping', 'POST', { items: [{ text: 'מצלמה', list: 'wish' }] }, 'avi');
await her.waitForTimeout(800);
const listTabs = (await her.locator('.shop-lists .seg-label').allInnerTexts()).join('|');
check('all five lists on one screen', listTabs === 'סופר|פארם|לבית|אישי|Wish', listTabs);
check('אישי opens on the personal list', await her.locator('.shop-lists .seg.on').innerText().then((t) => t.includes('אישי')));
await her.locator('.shop-lists .seg', { hasText: 'Wish' }).click(); await her.waitForTimeout(300);
await her.fill('.shopping .qa-input', 'שעון חכם'); await her.keyboard.press('Enter'); await her.waitForTimeout(700);
check('her wish shows "שלי"; Avi\'s shows his name', (await her.locator('.shop-row', { hasText: 'שעון חכם' }).innerText()).includes('שלי') && (await her.locator('.wish-row', { hasText: 'מצלמה' }).innerText()).includes('אבי'));
await her.locator('.wish-row', { hasText: 'מצלמה' }).locator('.claim-btn').click(); await her.waitForTimeout(600);
check('"אני אקנה" on his wish', (await api('/api/shopping', 'GET', undefined, 'maya')).items.find((x) => x.text === 'מצלמה')?.claimed_by === 'maya');
check('…and Avi never sees who is buying', (await api('/api/shopping', 'GET', undefined, 'avi')).items.find((x) => x.text === 'מצלמה')?.claimed_by === undefined);
await pick(her, 'בית'); await her.goto(`${base}/#/shopping`); await her.waitForTimeout(400);
check('בית opens on סופר', await her.locator('.shop-lists .seg.on').innerText().then((t) => t.includes('סופר')));
await pick(her, 'הכל');

// ================= Avi's phone: live update from her change =================
const { pg: avi } = await phone('avi');
await avi.goto(`${base}/`); await avi.evaluate(() => localStorage.setItem('wb-ui', JSON.stringify({ space: 'all' })));
await avi.reload(); await avi.goto(`${base}/#/shopping`); await avi.waitForSelector('.shopping'); await avi.waitForTimeout(500);
await api('/api/shopping', 'POST', { items: [{ text: 'קפה' }] }, 'maya');
await avi.waitForTimeout(1200);
check('Avi sees her addition live', (await avi.locator('.shopping').innerText()).includes('קפה'));
await avi.goto(`${base}/#/today`); await avi.waitForTimeout(600);
const talToday = (await avi.locator('.view-host .group, .view-host .day-card').allInnerTexts()).join('\n');
const talCheck = await avi.locator('.row .check').first().getAttribute('aria-label');
check('Avi\'s app in the masculine', /סמן "/.test(talCheck || '') && !/סמני/.test(talCheck || ''), talCheck);
check('Avi\'s Today: work + personal + plumber, not her stuff', /מצגת ללקוח/.test(talToday) && /מתנה לאמא/.test(talToday) && /אינסטלטור/.test(talToday) && !/ארנונה|שיננית/.test(talToday), talToday.replace(/\s+/g, ' ').slice(0, 500));
// Her agent changes a shared task → Avi gets a toast naming נובה.
const plumber = (await api(`/api/tasks?q=${encodeURIComponent('אינסטלטור')}`)).items[0];
await api(`/api/tasks/${plumber.id}`, 'PATCH', { assignee: 'both' }, 'maya', 'nova');
await avi.waitForTimeout(2000);
check('toast names her agent', (await avi.locator('.toast').allInnerTexts()).join(' ').includes('נובה'));

// A deploy while the app is open: coming back to it picks up the new build by itself.
await avi.goto(`${base}/#/today`); await avi.waitForTimeout(600);
await avi.evaluate(() => { window.__old = true; });
await avi.route('**/api/version', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: 'newbuild0001' }) }));
await avi.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await avi.waitForTimeout(1500);
check('a new version reloads the app when it comes back to the foreground', await avi.evaluate(() => !window.__old));
console.log(results.join('\n'));
console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(results.some((r) => r.startsWith('❌')) || errors.length ? 1 : 0);
