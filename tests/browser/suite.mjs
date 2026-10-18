// End-to-end browser suite (desktop + iPhone-sized touch). Run with tests/browser/run.sh.
// Needs Playwright outside the repo (zero-dependency app): PW_DIR=/tmp/pw with `npm i playwright` +
// `PLAYWRIGHT_BROWSERS_PATH=$PW_DIR/browsers npx playwright install chromium-headless-shell`.
import { createRequire } from 'node:module';

const { chromium } = createRequire(`${process.env.PW_DIR || '/tmp/pw'}/package.json`)('playwright');
const base = process.env.BASE || 'http://127.0.0.1:4199';
const api = async (path, method = 'GET', body, actor) => (await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(actor && { 'x-actor': actor }) }, body: body && JSON.stringify(body) })).json();
const results = [];
// A touch held in place (long press), via CDP so it is a real touch, not a mouse.
async function cdpTouchHold(ctx, pg, x, y, ms) {
  const cdp = await ctx.newCDPSession(pg);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await pg.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await pg.waitForTimeout(300);
}
const check = (name, ok, extra = '') => { results.push(`${ok ? '✅' : '❌'} ${name}${extra ? ` ${extra}` : ''}`); };
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

// ---- seed ----
await api('/api/schema', 'PATCH', { projects: [{ id: 'quarterly', name: 'דוח רבעוני', color: 'purple' }, { id: 'tender', name: 'מכרז 2027', color: 'blue' }] });
for (const t of [
  { title: 'להכין מצגת לישיבת הנהלה', status: 'doing', priority: 'high', project: 'quarterly', when: day(0), deadline: day(1), steps: [{ text: 'נתונים', done: true }, { text: 'טיוטה', done: false }] },
  { title: 'לחזור לספק לגבי הצעת מחיר', status: 'waiting', project: 'tender' },
  { title: 'Review מסמך הדרישות של המכרז', priority: 'urgent', project: 'tender', deadline: day(-1) },
  { title: 'לקבוע 1:1 עם מאיה', when: day(2) },
  { title: 'לעדכן נוהל גיבויים', status: 'someday' },
  { title: 'לשלוח חשבונית לרו״ח', deadline: day(4) },
]) await api('/api/tasks', 'POST', t);
await api('/api/tasks', 'POST', { title: 'לתאם הדרכת אבטחת מידע', steps: ['תאריכים', 'חדר'] }, 'agent');

const browser = await chromium.launch();
const errors = [];
process.on('uncaughtException', (e) => { console.log(results.join('\n')); console.log('CRASH', e.message); process.exit(1); });

// ================= desktop =================
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
page.on('pageerror', (e) => errors.push(`desktop: ${e.message}`));
await page.goto(`${base}/#/today`); await page.waitForSelector('.row');

await page.fill('.qa-input', 'לכתוב סיכום #דוחות !! +דוח');
await page.keyboard.press('Enter'); await page.waitForTimeout(500);
let t = (await api(`/api/tasks?q=${encodeURIComponent('לכתוב סיכום')}`)).items[0];
check('quick add parses tag/priority/project/when', t && t.tags.includes('דוחות') && t.priority === 'urgent' && t.project === 'quarterly' && t.when);

await page.locator(`.row[data-id="${t.id}"] .check`).click(); await page.waitForTimeout(500);
check('check marks done', (await api(`/api/tasks/${t.id}`)).status === 'done');
await page.click('.toast-action'); await page.waitForTimeout(500);
check('toast undo restores', (await api(`/api/tasks/${t.id}`)).status !== 'done');

await page.goto(`${base}/#/task/${t.id}`); await page.waitForSelector('.drawer'); await page.waitForTimeout(600);
await page.locator('.step-add').fill('שלב ראשון'); await page.locator('.step-add').press('Enter'); await page.waitForTimeout(400);
await page.locator('.step-add').fill('שלב שני'); await page.locator('.step-add').press('Enter'); await page.waitForTimeout(400);
check('focus stays in step adder', await page.evaluate(() => document.activeElement?.classList.contains('step-add')));
await page.locator('.step-check').first().click(); await page.waitForTimeout(400);
t = await api(`/api/tasks/${t.id}`);
check('steps added and checked', t.steps.length === 2 && t.steps[0].done && !t.steps[1].done);

await page.click('.notes'); await page.keyboard.type('הערה שאני מקליד');
await api(`/api/tasks/${t.id}`, 'PATCH', { priority: 'low' }, 'agent'); await page.waitForTimeout(300);
await page.keyboard.type(' ועוד'); await page.waitForTimeout(2800);
t = await api(`/api/tasks/${t.id}`);
check('typing survives a live agent update', t.notes === 'הערה שאני מקליד ועוד' && t.priority === 'low', JSON.stringify(t.notes));

await page.locator('.preset-row .chip-btn').first().click(); await page.waitForTimeout(500);
check('reminder preset adds a reminder', (await api(`/api/tasks/${t.id}`)).reminders.length === 1);
await page.fill('.drawer-title', 'לכתוב סיכום רבעוני'); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
check('title edit saved', (await api(`/api/tasks/${t.id}`)).title === 'לכתוב סיכום רבעוני');
await page.keyboard.press('Escape'); await page.waitForTimeout(800);
check('Esc closes the sheet (after it animates out)', !(await page.locator('.drawer').count()));

await page.goto(`${base}/#/board`); await page.waitForSelector('.card');
const card = page.locator('.column[data-status="next"] .card').first();
const cardId = await card.getAttribute('data-id');
await card.dragTo(page.locator('.column[data-status="doing"] .column-body')); await page.waitForTimeout(600);
check('desktop board: drag changes status', (await api(`/api/tasks/${cardId}`)).status === 'doing');

await page.goto(`${base}/#/all`); await page.waitForTimeout(500);
await api('/api/tasks', 'POST', { title: 'משימה חיה מהסוכן' }, 'agent'); await page.waitForTimeout(1800);
check('live: agent task appears', await page.locator('text=משימה חיה מהסוכן').count() > 0);
check('live: one toast for the agent', (await page.locator('.toast').allTextContents()).some((x) => x.includes('הסוכן')));

const schema = await api('/api/schema');
schema.statuses.splice(3, 0, { id: 'review', label: 'בבדיקה', category: 'active', color: 'pink' });
await fetch(`${base}/api/schema`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-actor': 'agent' }, body: JSON.stringify(schema) });
await page.goto(`${base}/#/board`); await page.waitForTimeout(600);
check('agent-added status becomes a column', await page.locator('.column[data-status="review"]').count() === 1);

await page.keyboard.press('n'); await page.keyboard.type('משימה מהפלטה @מחר'); await page.keyboard.press('Enter'); await page.waitForTimeout(900);
check('palette creates and opens the task', await page.locator('.drawer-title').inputValue() === 'משימה מהפלטה');
await page.keyboard.press('Escape'); await page.waitForTimeout(800);
await page.keyboard.press('/'); await page.keyboard.type('מצגת'); await page.waitForTimeout(400);
check('search filters', (await page.locator('.row').count()) === 1);

await page.goto(`${base}/#/projects`); await page.waitForTimeout(400);
await page.fill('.project-new input', 'פרויקט בדיקה'); await page.keyboard.press('Enter'); await page.waitForTimeout(600);
check('project created', (await api('/api/schema')).projects.some((p) => p.name === 'פרויקט בדיקה'));

const fresh = await api('/api/tasks', 'POST', { title: 'בדיקת נראה' }, 'agent');
let patches = 0; page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().endsWith(`/api/tasks/${fresh.id}`)) patches += 1; });
await page.goto(`${base}/#/task/${fresh.id}`); await page.waitForTimeout(1500);
check('opening an unseen task marks it seen once', patches === 1, `patches=${patches}`);
await page.fill('[data-key^="rem-note-"]', 'טיוטת תזכורת');
await api(`/api/tasks/${fresh.id}`, 'PATCH', { priority: 'high' }, 'agent'); await page.waitForTimeout(700);
check('reminder draft survives a re-render', (await page.inputValue('[data-key^="rem-note-"]')) === 'טיוטת תזכורת');

// ================= iPhone-sized, touch =================
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const m = await ctx.newPage();
m.on('pageerror', (e) => errors.push(`mobile: ${e.message}`));
const cdp = await ctx.newCDPSession(m);
const touchDrag = async (x, y, dx, dy, steps, ms) => {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps }] }); await m.waitForTimeout(ms); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await m.waitForTimeout(700);
};

for (const v of ['#/today', '#/focus', '#/board', '#/timeline', '#/projects', '#/all', '#/settings', '#/done']) {
  await m.goto(`${base}/${v}`); await m.waitForTimeout(600);
  const w = await m.evaluate(() => Math.max(document.documentElement.scrollWidth, document.querySelector('.main')?.scrollWidth || 0));
  if (w > 394) check(`no horizontal overflow on ${v}`, false, `width ${w}`);
}
check('no horizontal overflow on phone views', !results.some((r) => r.includes('overflow on')));

await m.goto(`${base}/#/all`); await m.waitForTimeout(800);
let box = await m.locator('.row').nth(0).boundingBox();
await touchDrag(box.x + 150, box.y + 30, 45, 0, 3, 10);
check('motion: a quick short flick opens the actions (velocity)', await m.locator('.swipe').nth(0).evaluate((e) => e.classList.contains('open-trail')));
await m.mouse.click(5, 300); await m.waitForTimeout(500);
box = await m.locator('.row').nth(1).boundingBox();
await touchDrag(box.x + 150, box.y + 30, 45, 0, 15, 40);
check('motion: a slow drag of the same distance springs back', !(await m.locator('.swipe').nth(1).evaluate((e) => e.classList.contains('open-trail'))));
const longId = await m.locator('.row').nth(2).getAttribute('data-id');
const beforeWhen = (await api(`/api/tasks/${longId}`)).when;
box = await m.locator('.row').nth(2).boundingBox();
await touchDrag(box.x + 300, box.y + 30, -330, 0, 12, 12);
await m.waitForTimeout(500);
check('motion: long swipe left postpones', (await api(`/api/tasks/${longId}`)).when !== beforeWhen);

await m.goto(`${base}/#/task/1`); await m.waitForTimeout(120);
const entering = await m.locator('.drawer').evaluate((e) => e.style.transform);
await m.waitForTimeout(900);
const settled = await m.locator('.drawer').evaluate((e) => e.style.transform);
check('motion: sheet springs in from the bottom', /translate3d\(0px?, ?[1-9]/.test(entering) && !settled, `${entering} → ${settled || 'none'}`);
const hb = await m.locator('.drawer-head').boundingBox();
await touchDrag(hb.x + 60, hb.y + 10, 0, 140, 4, 12);
check('motion: a fast flick down dismisses the sheet', await m.locator('.drawer').count() === 0);
await m.goto(`${base}/#/task/2`); await m.waitForTimeout(900);
await m.click('.drawer-head button[title^="סגור"]'); await m.waitForTimeout(90);
const leaving = await m.locator('.drawer').evaluate((e) => e.style.transform).catch(() => '');
await m.waitForTimeout(800);
check('motion: × leaves the way it came (down)', /translate3d\(0px?, ?[1-9]/.test(leaving) && await m.locator('.drawer').count() === 0, leaving);

// Steps reorder by finger (HTML5 drag-and-drop never fires on iOS).
await m.goto(`${base}/#/task/1`); await m.waitForTimeout(900);
const firstStep = (await api('/api/tasks/1')).steps[0].text;
const g = await m.locator('.step .grip').nth(0).boundingBox();
const rowH = (await m.locator('.step').nth(0).boundingBox()).height;
await touchDrag(g.x + g.width / 2, g.y + g.height / 2, 0, rowH * 1.1, 8, 25);
await m.waitForTimeout(400);
check('motion: steps reorder by dragging the grip (touch)', (await api('/api/tasks/1')).steps[1].text === firstStep);
await m.goto(`${base}/#/today`); await m.waitForTimeout(700);

// Sidebar: springs open, follows the finger closed.
await m.click('.menu-btn'); await m.waitForTimeout(80);
const navMid = await m.locator('.sidebar').evaluate((e) => e.style.transform);
await m.waitForTimeout(700);
check('motion: menu springs open', /translate3d\([1-9]/.test(navMid) && await m.locator('body.nav-open').count() === 1, navMid);
const sb = await m.locator('.sidebar').boundingBox();
await touchDrag(sb.x + 120, sb.y + 400, 160, 0, 4, 12);
check('motion: a flick toward the edge closes the menu', await m.locator('body.nav-open').count() === 0);

// Toast: flick away.
await m.evaluate(() => import('/js/actions.js').then((a) => a.toast('בדיקת החלקה', { timeout: 20000 })));
await m.waitForTimeout(400);
const tb = await m.locator('.toast').last().boundingBox();
await touchDrag(tb.x + tb.width - 20, tb.y + tb.height / 2, 0, 70, 3, 12); // on the text, not the × (RTL: × is on the left)
check('motion: a toast can be flicked away', !(await m.locator('.toast', { hasText: 'בדיקת החלקה' }).count()));

// Reduced motion: no slide, a cross-fade instead.
const rm = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
const r = await rm.newPage();
r.on('pageerror', (e) => errors.push(`reduced: ${e.message}`));
await r.addInitScript(() => { const orig = Element.prototype.animate; Element.prototype.animate = function (k, o) { if (this.classList.contains('drawer')) window.__fade = JSON.stringify(k); return orig.call(this, k, o); }; });
await r.goto(`${base}/#/task/1`); await r.waitForTimeout(400);
const rmState = await r.locator('.drawer').evaluate((e) => ({ t: e.style.transform, fading: /opacity/.test(window.__fade || '') }));
check('reduced motion: sheet fades instead of sliding', !rmState.t && rmState.fading, JSON.stringify(rmState));
await rm.close();

// ---- Stale responses never roll the board back (Hermes review, bug 4) ----
{
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(`race: ${e.message}`));
  await p.goto(`${base}/#/today`); await p.waitForSelector('.row');
  const id = (await api('/api/tasks', 'POST', { title: 'מרוץ', priority: 'normal' })).id;
  await p.waitForTimeout(400);
  let releaseA; const heldA = new Promise((r) => { releaseA = r; });
  let first = true;
  await p.route(`**/api/tasks/${id}`, async (route) => {
    if (route.request().method() !== 'PATCH' || !first) return route.continue();
    first = false;
    const response = await route.fetch(); // A commits on the server…
    await heldA; // …but its answer arrives late
    await route.fulfill({ response });
  });
  await p.evaluate((id) => { import('/js/actions.js').then((a) => { window.__a = a.updateTask(id, { when: '2030-03-10' }); }); }, id);
  await p.waitForTimeout(300);
  await p.evaluate((id) => import('/js/actions.js').then((a) => a.updateTask(id, { priority: 'high' })), id);
  await p.waitForTimeout(400); // B answered and its live event arrived
  releaseA(); await p.evaluate(() => window.__a); await p.waitForTimeout(300);
  const ui = await p.evaluate((id) => import('/js/store.js').then((s) => { const t = s.state.tasks.get(id); return { when: t.when, priority: t.priority }; }), id);
  check('stale response does not roll back a newer change', ui.when === '2030-03-10' && ui.priority === 'high', JSON.stringify(ui));
  // A failed save restores the server truth, not an old snapshot.
  await p.unroute(`**/api/tasks/${id}`);
  await api(`/api/tasks/${id}`, 'PATCH', { notes: 'מהסוכן' }, 'agent');
  await p.route(`**/api/tasks/${id}`, (route) => (route.request().method() === 'PATCH' ? route.fulfill({ status: 500, body: '{"error":"x"}' }) : route.continue()));
  await p.evaluate((id) => import('/js/actions.js').then((a) => a.updateTask(id, { title: 'שינוי שנכשל' })), id);
  await p.waitForTimeout(400);
  const after = await p.evaluate((id) => import('/js/store.js').then((s) => s.state.tasks.get(id)), id);
  // Same field twice: the later intent wins even while the earlier write is still in flight.
  await p.unroute(`**/api/tasks/${id}`);
  let releaseC; const heldC = new Promise((r) => { releaseC = r; }); let firstC = true;
  await p.route(`**/api/tasks/${id}`, async (route) => {
    if (route.request().method() !== 'PATCH' || !firstC) return route.continue();
    firstC = false; const response = await route.fetch(); await heldC; await route.fulfill({ response });
  });
  await p.evaluate((id) => { import('/js/actions.js').then((a) => { window.__c = a.updateTask(id, { priority: 'low' }); }); }, id);
  await p.waitForTimeout(300);
  await p.evaluate((id) => import('/js/actions.js').then((a) => a.updateTask(id, { priority: 'urgent' })), id);
  await p.waitForTimeout(300);
  const mid = await p.evaluate((id) => import('/js/store.js').then((s) => s.state.tasks.get(id).priority), id);
  releaseC(); await p.evaluate(() => window.__c); await p.waitForTimeout(300);
  check('same field twice: the newer edit shows while the older is in flight', mid === 'urgent', mid);
  // A late reply about a task deleted meanwhile must not bring it back.
  await p.unroute(`**/api/tasks/${id}`);
  const doomed = (await api('/api/tasks', 'POST', { title: 'תימחק' })).id;
  await p.waitForTimeout(300);
  let releaseD; const heldD = new Promise((r) => { releaseD = r; });
  await p.route(`**/api/tasks/${doomed}`, async (route) => { if (route.request().method() !== 'PATCH') return route.continue(); const response = await route.fetch(); await heldD; await route.fulfill({ response }); });
  await p.evaluate((doomed) => { import('/js/actions.js').then((a) => { window.__d = a.updateTask(doomed, { priority: 'high' }); }); }, doomed);
  await p.waitForTimeout(300);
  await api(`/api/tasks/${doomed}`, 'DELETE', undefined, 'agent');
  await p.waitForTimeout(400);
  releaseD(); await p.evaluate(() => window.__d); await p.waitForTimeout(300);
  check('a late reply does not resurrect a deleted task', !(await p.evaluate((doomed) => import('/js/store.js').then((s) => s.state.tasks.has(doomed)), doomed)));
  await p.unroute(`**/api/tasks/${doomed}`);
  check('failed save shows the server truth', after.title === 'מרוץ' && after.notes === 'מהסוכן', JSON.stringify({ title: after.title, notes: after.notes }));
  await c.close();
}

// ---- Offline snapshot reflects confirmed changes and says how old it is (bug 5) ----
{
  const c = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(`offline: ${e.message}`));
  await p.goto(`${base}/#/all`); await p.waitForSelector('.row');
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.reload(); await p.waitForSelector('.row');
  const created = await p.evaluate(() => import('/js/actions.js').then((a) => a.createTask({ title: 'נוצרה לפני ניתוק' })));
  await p.evaluate((id) => import('/js/actions.js').then((a) => a.updateTask(id, { title: 'נערכה לפני ניתוק' })), created.id);
  await api('/api/tasks', 'POST', { title: 'מהסוכן לפני ניתוק' }, 'agent');
  await p.waitForTimeout(1500);
  await c.setOffline(true);
  await p.reload(); await p.waitForSelector('.row', { timeout: 5000 }).catch(() => {});
  const text = await p.locator('#app').innerText().catch(() => '');
  check('offline: shows confirmed edits and live agent changes', text.includes('נערכה לפני ניתוק') && text.includes('מהסוכן לפני ניתוק') && !text.includes('נוצרה לפני ניתוק'));
  let writes = 0;
  p.on('request', (r) => { if (r.method() !== 'GET') writes += 1; });
  await p.locator('.row .check').first().click().catch(() => {});
  await p.waitForTimeout(400);
  check('offline: read-only is enforced (no write is even attempted)', writes === 0, `writes=${writes}`);
  check('offline: banner says it is a snapshot and its age', /אין חיבור — מוצג המצב מ/.test(text));
  await c.close();
}

// ---- Free time page ----
{
  await api('/api/schema', 'PATCH', { fields: [...(await api('/api/schema')).fields, { id: 'kind', label: 'סוג עבודה', type: 'select', options: ['עבודה עצמאית', 'עבודה משותפת', 'תיאום', 'מעקב'] }] });
  const solo = (await api('/api/tasks', 'POST', { title: 'לכתוב מסמך לבד', priority: 'urgent', fields: { kind: 'עבודה עצמאית' }, steps: ['שלד', 'טיוטה'] })).id;
  const c = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(`focus: ${e.message}`));
  await p.goto(`${base}/#/focus`); await p.waitForSelector('.focus-hero');
  check('free time: the top independent task leads, with its reason and next step', (await p.locator('.focus-hero').innerText()).includes('לכתוב מסמך לבד') && (await p.locator('.focus-hero').innerText()).includes('הצעד הבא: שלד'));
  const uncCount = async () => Number(await p.locator('.group', { hasText: 'עוד לא סווגו' }).locator('.count').innerText());
  const unc = await uncCount();
  await p.locator('.classify-row').first().locator('.kind-solo').click(); await p.waitForTimeout(500);
  check('free time: one tap classifies a task', (await uncCount()) === unc - 1, `${unc} → ${await uncCount()}`);
  await p.locator('.seg', { hasText: 'תיאומים' }).click(); await p.waitForTimeout(200);
  check('free time: coordination mode switches the list', !(await p.locator('.focus-hero').count()) || !(await p.locator('.focus-hero').innerText()).includes('לכתוב מסמך לבד'));
  await api(`/api/tasks/${solo}`, 'DELETE');
  await c.close();
}

// ---- UX pass: search survives opening a task; people are links; activity batch undo; armed long swipe ----
{
  const c = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(`ux: ${e.message}`));
  const sch = await api('/api/schema');
  if (!sch.fields.some((f) => f.id === 'with')) await api('/api/schema', 'PATCH', { fields: [...sch.fields, { id: 'with', label: 'עם מי', type: 'text', showOnCard: true }] });
  const benId = (await api('/api/tasks', 'POST', { title: 'משימה עם אבי', fields: { with: 'אבי, מאיה' } })).id;
  await p.goto(`${base}/#/all`); await p.waitForSelector('.row');
  await p.locator('.person-link', { hasText: 'מאיה' }).first().click(); await p.waitForTimeout(300);
  check('people: tapping a name searches for that person', (await p.locator('.view-head h1').innerText()).includes('מאיה'));
  await p.locator('.row', { hasText: 'משימה עם אבי' }).first().click(); await p.waitForTimeout(700);
  await p.keyboard.press('Escape'); await p.waitForTimeout(900);
  check('search survives opening and closing a task', (await p.locator('.view-head h1').innerText()).includes('מאיה'));
  // Hermes batch → activity page → undo all
  await p.locator('button', { hasText: 'נקה חיפוש' }).click();
  await api(`/api/tasks/${benId}`, 'PATCH', { title: 'באצ׳ 1' }, 'agent');
  await api(`/api/tasks/${benId}`, 'PATCH', { status: 'doing' }, 'agent');
  await p.goto(`${base}/#/activity`); await p.waitForTimeout(800);
  check('activity: readable status/date summaries', (await p.locator('.feed-page').first().innerText()).includes('הבא בתור → בעבודה'));
  await p.locator('.link-btn', { hasText: 'בטל הכל' }).first().click(); await p.waitForTimeout(1200);
  const after = await api(`/api/tasks/${benId}`);
  check('activity: one tap undoes a whole Hermes batch', after.title === 'משימה עם אבי' && after.status === 'next', `${after.title}/${after.status}`);
  await c.close();
}

// ---- Navigation, row menu, start/done, effort filter ----
{
  const sch = await api('/api/schema');
  const want = [{ id: 'kind', label: 'סוג עבודה', type: 'select', options: ['עבודה עצמאית', 'עבודה משותפת', 'תיאום', 'מעקב'] }, { id: 'effort', label: 'משך', type: 'select', options: ['רבע שעה', 'חצי שעה', 'שעה', 'חצי יום', 'יום ומעלה'] }];
  await api('/api/schema', 'PATCH', { fields: [...sch.fields.filter((f) => !want.some((w) => w.id === f.id)), ...want] });
  const c = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(`nav: ${e.message}`));
  await p.goto(`${base}/#/today`); await p.waitForSelector('.mnav');
  check('phone tabs: היום · יומן · משימות · פרויקטים', (await p.locator('.mnav span:first-of-type').allInnerTexts()).join('|') === 'היום|יומן|משימות|פרויקטים', (await p.locator('.mnav span:first-of-type').allInnerTexts()).join('|'));
  await p.locator('.today-modes .seg', { hasText: 'יש לי זמן פנוי' }).click(); await p.waitForTimeout(500);
  check('free time is a mode of היום (tab stays active)', p.url().endsWith('#/focus') && (await p.locator('.mnav.active').innerText()).includes('היום'));
  const quick = (await api('/api/tasks', 'POST', { title: 'מייל של רבע שעה', fields: { kind: 'עבודה עצמאית', effort: 'רבע שעה' } })).id;
  const big = (await api('/api/tasks', 'POST', { title: 'פרויקט של יום', priority: 'urgent', fields: { kind: 'עבודה עצמאית', effort: 'יום ומעלה' } })).id;
  await p.waitForTimeout(500);
  await p.locator('.time-chip', { hasText: 'חצי שעה' }).click(); await p.waitForTimeout(300);
  const focusText = await p.locator('.view-host').innerText();
  check('free time: "חצי שעה" hides what does not fit', focusText.includes('מייל של רבע שעה') && !focusText.includes('פרויקט של יום'));
  // Row menu
  await p.goto(`${base}/#/all`); await p.waitForTimeout(700);
  await p.locator('.row', { hasText: 'מייל של רבע שעה' }).locator('.row-menu').click(); await p.waitForTimeout(300);
  check('row menu opens with dates, statuses and work type', (await p.locator('.action-sheet').count()) === 1 && (await p.locator('.as-group').count()) >= 3);
  await p.locator('.as-item', { hasText: 'שבוע הבא' }).click(); await p.waitForTimeout(500);
  check('row menu: "שבוע הבא" moves the task', Boolean((await api(`/api/tasks/${quick}`)).when) && (await p.locator('.action-sheet').count()) === 0);
  // Long press opens the same menu
  await p.waitForTimeout(800); // the list re-sorts after the move above
  const lpRow = p.locator('.row', { hasText: 'פרויקט של יום' });
  await lpRow.scrollIntoViewIfNeeded(); await p.waitForTimeout(300);
  const box = await lpRow.boundingBox();
  await cdpTouchHold(c, p, box.x + 150, box.y + 25, 650);
  check('long press opens the row menu (and lifting the finger keeps it open)', (await p.locator('.action-sheet').count()) === 1);
  await p.keyboard.press('Escape'); await p.locator('.as-host').click({ position: { x: 5, y: 5 } }).catch(() => {});
  // Start → done from the sheet
  await p.goto(`${base}/#/task/${big}`); await p.waitForTimeout(900);
  await p.locator('.work-btn', { hasText: 'התחל לעבוד' }).click(); await p.waitForTimeout(500);
  check('sheet: "התחל לעבוד" moves to in progress', (await api(`/api/tasks/${big}`)).status === 'doing');
  await p.locator('.work-btn', { hasText: 'סיימתי' }).click(); await p.waitForTimeout(500);
  check('sheet: "סיימתי" completes it', (await api(`/api/tasks/${big}`)).status === 'done');
  await c.close();
}

// ---- Schedule (לו״ז) ----
{
  const c = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Jerusalem' });
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(`schedule: ${e.message}`));
  const todayIL = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  const taskId = (await api('/api/tasks', 'POST', { title: 'מצגת ללקוח' })).id;
  await api('/api/schedule', 'POST', { title: 'דיון עם רוני', date: todayIL, start: '23:58', end: '23:59', with: 'רוני' });
  await api('/api/schedule', 'POST', { title: 'עע מצגת', date: todayIL, start: '23:50', end: '23:58', kind: 'work', task: taskId });
  await p.goto(`${base}/#/today`); await p.waitForSelector('.schedule');
  const text = await p.locator('.schedule').innerText();
  check('Today shows the schedule in time order', text.indexOf('עע מצגת') > -1 && text.indexOf('עע מצגת') < text.indexOf('דיון עם רוני'), text.slice(0, 120));
  await p.locator('.ev', { hasText: 'דיון עם רוני' }).click(); await p.waitForTimeout(300);
  await p.locator('.as-item', { hasText: 'הסר מהלו״ז' }).click(); await p.waitForTimeout(600);
  check('an item can be removed', !(await p.locator('.schedule').innerText()).includes('דיון עם רוני'));
  await p.locator('.toast-action', { hasText: 'ביטול' }).last().click(); await p.waitForTimeout(800);
  check('…and the removal undone', (await p.locator('.schedule').innerText()).includes('דיון עם רוני'));
  await p.goto(`${base}/#/task/${taskId}`); await p.waitForTimeout(900);
  check('the task sheet shows its booked time', (await p.locator('.work-schedule').innerText()).includes('23:50'));
  await p.locator('.work-schedule .link-btn').click(); await p.waitForTimeout(300);
  await p.locator('.ev-form input[aria-label="התחלה"]').fill('23:40');
  await p.locator('.ev-form .btn.primary').click(); await p.waitForTimeout(700);
  check('booking more time from the task adds a linked item', (await api('/api/schedule')).items.filter((e) => e.task === taskId).length === 2);
  await c.close();
}

console.log(results.join('\n'));
console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(results.some((r) => r.startsWith('❌')) || errors.length ? 1 : 0);
