// iOS zooms into any focused field whose font is under 16px (and on a quick double tap where touch-action allows it).
// This walks the screens and sheets and lists every field that would trigger it. SUITE=zoom tests/browser/run.sh
import { createRequire } from 'node:module';
const { chromium } = createRequire(`${process.env.PW_DIR || '/tmp/pw'}/package.json`)('playwright');
const base = process.env.BASE;
const api = async (path, method = 'GET', body) => (await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-user': 'avi' }, body: body && JSON.stringify(body) })).json();
await api('/api/shopping', 'POST', { items: [{ text: 'חלב' }, { text: 'שמפו', list: 'pharm' }] });
const t = await api('/api/tasks', 'POST', { title: 'בדיקה', space: 'work' });
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, extraHTTPHeaders: { 'x-user': 'avi' } });
const small = async (where) => pg.evaluate((w) => [...document.querySelectorAll('input, select, textarea')].filter((el) => el.offsetParent && el.type !== 'checkbox' && parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => `${w}: <${el.tagName.toLowerCase()} class="${el.className}" aria="${el.getAttribute('aria-label') || el.placeholder || ''}"> ${getComputedStyle(el).fontSize}`), where);
const out = [];
const visit = async (hash, name, prep) => { await pg.goto(`${base}/${hash}`); await pg.waitForTimeout(700); if (prep) await prep(); out.push(...await small(name)); };
await visit('#/shopping', 'shopping');
await visit('#/shopping', 'shopping item sheet', async () => { await pg.locator('.shop-row .row-menu').first().click(); await pg.waitForTimeout(300); });
await visit('#/today', 'today');
await visit('#/all', 'tasks');
await visit(`#/task/${t.id}`, 'task sheet');
await visit('#/timeline', 'timeline');
await visit('#/today', 'event form', async () => { await pg.locator('.schedule .icon-btn').first().click(); await pg.waitForTimeout(300); });
await visit('#/settings', 'settings');
await visit('#/projects', 'projects');
await visit('#/today', 'palette', async () => { await pg.locator('.dock-add').click(); await pg.waitForTimeout(300); });
const touch = await pg.evaluate(() => getComputedStyle(document.documentElement).touchAction);
console.log(out.length ? out.join('\n') : 'no field under 16px');
console.log('html touch-action:', touch);
process.exitCode = out.length || touch !== 'pan-x pan-y' ? 1 : 0;
// Pages wider than the screen let iOS zoom/pan sideways: report any.
const p2 = await b.newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, extraHTTPHeaders: { 'x-user': 'avi' } });
for (const hash of ['#/today', '#/all', '#/projects', '#/shopping', '#/timeline', '#/settings', '#/activity']) {
  await p2.goto(`${base}/${hash}`); await p2.waitForTimeout(700);
  const r = await p2.evaluate(() => { const w = innerWidth; const wide = [...document.querySelectorAll('body *')].filter((el) => { const bb = el.getBoundingClientRect(); return bb.width && (bb.right > w + 1 || bb.left < -1) && getComputedStyle(el).position !== 'fixed' && !el.closest('.swipe-actions'); }).slice(0, 6).map((el) => `${el.tagName.toLowerCase()}.${String(el.className.baseVal ?? el.className).split(' ')[0]} ${Math.round(el.getBoundingClientRect().left)}..${Math.round(el.getBoundingClientRect().right)}`); return { sw: document.documentElement.scrollWidth, w, wide }; });
  console.log(hash, r.sw, r.w, r.wide.join(' | '));
}
await b.close();
