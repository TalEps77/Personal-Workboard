import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth, deviceLabel } from './auth.js';
import { createLock } from './fs-util.js';
import { createSchemaStore } from './schema.js';
import { createTaskStore } from './task-store.js';
import { createScheduler } from './scheduler.js';
import { createNotifiers } from './notifier.js';
import { buckets, categoryOf, summaryText } from './summary.js';
import { TZ, addDays, today } from './time.js';
import { localeInfo } from './locale.js';
import { createAgentTools } from './agent.js';
import { createEventStore } from './events.js';
import { createAccess, loadPeople, scopeEvents, scopeTasks } from './access.js';
import { createShoppingStore, DEPTS } from './shopping.js';
import { createOrgSync } from './org-sync.js';
import { createPocketIntake, POCKET_MAX_BODY } from './pocket.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const send = (res, status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(data)); };
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const CODES = { 400: 'invalid', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'too_large', 415: 'unsupported_media_type', 421: 'unknown_host', 429: 'rate_limited', 503: 'unavailable' };
const body = (req) => new Promise((resolve, reject) => {
  let text = '';
  req.setEncoding('utf8');
  req.on('error', reject);
  req.on('data', (chunk) => { text += chunk; if (text.length > 512_000) { reject(fail(413, 'too_large', 'Request too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(text ? JSON.parse(text) : {}); } catch { reject(fail(400, 'invalid_json', 'Invalid JSON')); } });
});
const rawBody = (req, limit) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('error', reject);
  req.on('data', (chunk) => { size += chunk.length; if (size > limit) { reject(fail(413, 'too_large', 'Request too large')); req.destroy(); } else chunks.push(chunk); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
});
const isJson = (req) => (req.headers['content-type'] || '').split(';')[0].trim() === 'application/json';
const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };
// DNS-rebinding guard: only answer to the names this board is actually reached by.
const ALLOWED_HOSTS = new Set((process.env.WORKBOARD_HOSTS || 'workboard:3000,workboard').split(',').map((x) => x.trim()).filter(Boolean));
const hostOk = (host = '') => ALLOWED_HOSTS.has(host) || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
const MAX_SSE = 20;

/** Server-side filtering, mainly for the agent (`GET /api/tasks?status=doing&q=…`). */
export function filterTasks(tasks, schema, q) {
  const t = today();
  const statuses = list(q.get('status')); const categories = list(q.get('category')); const projects = list(q.get('project')); const tags = list(q.get('tag')); const priorities = list(q.get('priority'));
  const text = (q.get('q') || '').trim().toLowerCase();
  const due = q.get('due');
  const open = q.get('open');
  return tasks.filter((x) => {
    const cat = categoryOf(schema, x.status);
    if (statuses.length && !statuses.includes(x.status)) return false;
    if (categories.length && !categories.includes(cat)) return false;
    if (open === '1' && cat === 'done') return false;
    if (projects.length && !projects.includes(x.project || 'none')) return false;
    if (priorities.length && !priorities.includes(x.priority)) return false;
    if (tags.length && !tags.some((tag) => x.tags.includes(tag))) return false;
    if (text && !`${x.id} ${x.title} ${x.notes} ${x.steps.map((s) => s.text).join(' ')} ${x.tags.join(' ')}`.toLowerCase().includes(text)) return false;
    // Date filters are about work still to do.
    if (due && cat === 'done') return false;
    if (due === 'overdue' && !(x.deadline && x.deadline < t)) return false;
    if (due === 'today' && !(x.deadline === t || (x.when && x.when <= t))) return false;
    if (due === 'week' && !((x.deadline && x.deadline <= addDays(t, 7)) || (x.when && x.when <= addDays(t, 7)))) return false;
    return true;
  });
}

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
/** A fingerprint of the app the browser runs (every file under public/): a deploy changes it, and open apps notice. */
export function buildVersion(dir = PUBLIC_DIR) {
  const hash = createHash('sha1');
  const walk = (d) => { for (const name of readdirSync(d).sort()) { const p = join(d, name); if (statSync(p).isDirectory()) walk(p); else hash.update(name).update(readFileSync(p)); } };
  try { walk(dir); } catch { return 'dev'; }
  return hash.digest('hex').slice(0, 12);
}

export function createApp({ root = process.cwd(), publicDir = PUBLIC_DIR, people = loadPeople(root), notifier = createNotifiers({ defaultUser: people.defaultUser }), schedulerInterval, agentToken, agentTokens, authDisabled = false, orgOptions = {}, pocketSpec, pocketOptions = {} } = {}) {
  const access = createAccess(people);
  const VERSION = buildVersion(publicDir);
  // Shopping lists belong to the household: everyone who shares the home space. (A declaration, so the SSE filter
  // above can use it before the store exists.)
  function canList(sc) {
    const home = sc.spaces.some((x) => x.kind === 'home');
    return (id) => Boolean(shopping.listOf(id)) && (sc.all || home);
  }
  // Live streams remember who opened them: a revoked or expired device stops receiving task data at once, and each
  // stream only carries what its person may see.
  const clients = new Map();
  const dropStream = (res) => { clients.delete(res); res.destroy(); };
  const visible = (event, sc) => {
    switch (event.type) {
      case 'task': return sc.canSeeTask(event.task);
      case 'delete': return sc.canSeeTask({ space: event.space });
      case 'activity': return sc.canSeeEntry(event.activity);
      case 'notification': return sc.all || (event.to || people.defaultUser) === sc.user;
      case 'shopping': return sc.all || (event.lists || []).some(canList(sc));
      default: return true;
    }
  };
  const broadcast = (event) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    const now = Date.now();
    for (const [res, who] of clients) {
      if (who.session && Date.parse(who.session.expires) <= now) { dropStream(res); continue; }
      if (!visible(event, who.scope)) continue;
      if (!res.write(data) && res.writableLength > 1_000_000) dropStream(res);
    }
  };
  // One lock for tasks AND structure, so a status can't be removed while a task is being moved into it.
  const lock = createLock();
  const schemaStore = createSchemaStore(join(root, 'data'), { lock });
  let orgSync = null; // optional link to a team board (server/org-sync.js)
  const taskStore = createTaskStore(root, { schemaStore, onChange: (e) => { broadcast(e); orgSync?.onChange(e); }, lock, people });
  orgSync = createOrgSync({ root, taskStore, schemaStore, people, ...orgOptions });
  schemaStore.setUsage(taskStore.usage);
  const eventStore = createEventStore(root, { lock, taskStore, onChange: broadcast });
  const shopping = createShoppingStore(root, { lock, onChange: broadcast });
  const scheduler = createScheduler({ root, taskStore, schemaStore, eventStore, notifier, access, onEvent: broadcast, interval: schedulerInterval });
  const auth = createAuth({ root, agentToken, ...(agentTokens !== undefined && { agentTokens }), people, disabled: authDisabled, sendCode: (message, user) => notifier.send(message, { event_type: 'workboard.pairing', to: user }) });
  const pocket = createPocketIntake({ root, taskStore, schemaStore, scheduler, people, ...(pocketSpec !== undefined && { spec: pocketSpec }), ...pocketOptions });
  const agentTools = createAgentTools({ taskStore, schemaStore, scheduler, eventStore, access, shopping, orgSync });
  /** Everything one request may touch, already narrowed to its person. */
  const ctxFor = (who) => {
    const sc = access.scope(who.user === undefined ? people.defaultUser : who.user);
    const tasks = scopeTasks(taskStore, sc, access);
    return { sc, tasks, events: scopeEvents(eventStore, sc, tasks), canList: sc.all ? null : canList(sc), canWrite: sc.all ? null : canList(sc) };
  };
  // Projects belong to a space; people only see (and can only change) the projects of their own spaces.
  const projectVisible = (sc, p) => sc.canSeeTask({ space: p.space || null });
  const schemaFor = (sc, schema) => (sc.all ? schema : { ...schema, projects: schema.projects.filter((p) => projectVisible(sc, p)) });
  const mergeSchemaInput = async (sc, input) => {
    if (sc.all || !Array.isArray(input.projects)) return input;
    const current = await schemaStore.get();
    const hidden = current.projects.filter((p) => !projectVisible(sc, p));
    const mine = input.projects.map((p) => {
      const was = current.projects.find((x) => x.id === p.id);
      if (was && !projectVisible(sc, was)) throw Object.assign(new Error(`Project id "${p.id}" is taken`), { status: 409, code: 'conflict' });
      const space = p.space ?? was?.space ?? sc.defaultSpace();
      if (!sc.spaces.some((x) => x.id === space)) throw Object.assign(new Error(`No access to space "${space}"`), { status: 403, code: 'forbidden' });
      return { ...p, space: space === people.defaultSpace ? (p.space ?? was?.space ?? null) : space };
    });
    return { ...input, projects: [...hidden, ...mine] };
  };
  let lastTestAt = 0;

  async function route(req, res, url) {
    const p = url.pathname;
    const m = (re) => p.match(re);
    const method = req.method;

    if (p === '/api/version') return send(res, 200, { version: VERSION });
    if (p === '/api/health') return send(res, 200, { ok: true, version: VERSION, notifier: scheduler.status(), agentToken: auth.agentConfigured, ...(process.env.WORKBOARD_INSTANCE && { instance: process.env.WORKBOARD_INSTANCE }) });

    // Inbound webhooks: no session — each one checks its sender's signature itself.
    const hook = m(/^\/hooks\/pocket\/([a-z0-9_-]{1,40})$/);
    if (hook) {
      if (method !== 'POST') return send(res, 405, { error: 'Use POST', code: 'method_not_allowed' }, { allow: 'POST' });
      if (!pocket.configured) return send(res, 404, { error: 'Not found', code: 'not_found' });
      const result = await pocket.receive(hook[1], await rawBody(req, POCKET_MAX_BODY), req.headers);
      send(res, result.status, result.body);
      result.after?.().catch((error) => console.error('pocket: notify failed', error));
      return undefined;
    }

    // ---- Pairing (the only data endpoints open without a session) ----
    if (p === '/api/auth/status' && method === 'GET') {
      const who = await auth.identify(req);
      // Names only (for "who are you?" on the pairing screen); the code still goes to that person's own WhatsApp.
      const users = access.multi ? people.users.map((u) => ({ id: u.id, name: u.name })) : [];
      return send(res, 200, { authenticated: Boolean(who), device: who?.session?.device || null, canSendCode: notifier.configured, users });
    }
    if (p === '/api/auth/request-code' && method === 'POST') {
      const input = await body(req);
      return send(res, 200, await auth.requestCode(deviceLabel(req.headers['user-agent']), input.user || people.defaultUser));
    }
    if (p === '/api/auth/verify' && method === 'POST') {
      const input = await body(req);
      const { token, maxAge } = await auth.verify(input.code, deviceLabel(req.headers['user-agent']), input.user || people.defaultUser);
      const secure = req.headers['x-forwarded-proto'] === 'https' || /\.ts\.net(:\d+)?$/.test(req.headers.host || '') ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'set-cookie': `${auth.COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}` });
    }

    // MCP (Streamable HTTP, stateless): the agent's typed tools. Same auth as the API.
    if (p === '/mcp') {
      const who = await auth.identify(req);
      if (!who) throw fail(401, 'unauthorized', 'Send an agent bearer token');
      if (method !== 'POST') return send(res, 405, { error: 'Use POST (stateless MCP; no SSE stream)', code: 'method_not_allowed' }, { allow: 'POST' });
      const input = await body(req);
      const batch = Array.isArray(input);
      const replies = (await Promise.all((batch ? input : [input]).map((msg) => agentTools.rpc(msg, { ...who, ...ctxFor(who) })))).filter(Boolean);
      if (!replies.length) { res.writeHead(202); res.end(); return undefined; }
      return send(res, 200, batch ? replies : replies[0]);
    }

    if (p.startsWith('/api/')) {
      const who = await auth.identify(req);
      if (!who) throw fail(401, 'unauthorized', 'This device is not paired. Open the dashboard and pair it, or send an agent bearer token.');
      return api(req, res, url, who);
    }

    if (!['GET', 'HEAD'].includes(method)) return send(res, 405, { error: 'Method not allowed', code: 'method_not_allowed' });
    let requested;
    try { requested = p === '/' ? '/index.html' : decodeURIComponent(p); } catch { return send(res, 400, { error: 'Bad path', code: 'invalid' }); }
    const path = join(publicDir, requested);
    if (!path.startsWith(`${publicDir}/`) || !isFile(path)) return send(res, 404, { error: 'Not found', code: 'not_found' });
    const content = await readFile(path);
    const cache = /\/(fonts|icons)\//.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': cache, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(method === 'HEAD' ? undefined : content);
    return undefined;
  }

  async function api(req, res, url, who) {
    const p = url.pathname;
    const m = (re) => p.match(re);
    const method = req.method;
    const actor = who.actor;
    const opts = { actor };
    const { sc, tasks: taskView, events: eventView, canList: can, canWrite: canW } = ctxFor(who);

    if (p === '/api/events' && method === 'GET') {
      if (clients.size >= MAX_SSE) throw fail(503, 'unavailable', 'Too many live connections');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`retry: 3000\ndata: ${JSON.stringify({ type: 'hello', version: VERSION })}\n\n`);
      clients.set(res, { ...who, scope: sc });
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      const drop = () => { clearInterval(ping); clients.delete(res); };
      req.on('close', drop);
      res.on('error', drop);
      return undefined;
    }

    if (p === '/api/bootstrap' && method === 'GET') {
      const [schema, tasks, activity, events, list] = await Promise.all([schemaStore.get(), taskView.list({ includeArchived: true }), taskView.activity({ limit: 30 }), eventView.list({ from: addDays(today(), -7) }), shopping.get(can, sc.user)]);
      return send(res, 200, { schema: schemaFor(sc, schema), degraded: schemaStore.degraded(), tasks, activity, events, shopping: list, depts: DEPTS.map(({ words, ...d }) => d), ...access.describe(sc.user), actor, version: VERSION, locale: localeInfo(TZ), notifier: scheduler.status(sc.user ?? undefined), today: today(), device: who.session?.device || null, org: { enabled: orgSync.configuredFor(sc.user ?? people.defaultUser), url: orgSync.url || null } });
    }

    if (p === '/api/sessions') {
      if (method === 'GET') return send(res, 200, { items: (await auth.list(sc.user)).map((s) => ({ ...s, current: s.id === who.session?.id })) });
    }
    let hit = m(/^\/api\/sessions\/([a-f0-9]+)$/);
    if (hit && method === 'DELETE') {
      if (who.kind !== 'session' && who.kind !== 'dev') throw fail(403, 'forbidden', 'Only a paired dashboard device can revoke devices');
      if (!(await auth.list(sc.user)).some((x) => x.id === hit[1])) throw fail(404, 'not_found', 'Device not found');
      const result = await auth.revoke(hit[1]);
      for (const [stream, owner] of clients) if (owner.session?.id === hit[1]) dropStream(stream);
      return send(res, 200, result);
    }

    if (p === '/api/schema') {
      if (method === 'GET') return send(res, 200, { ...schemaFor(sc, await schemaStore.get()), degraded: schemaStore.degraded() || undefined });
      if (method === 'PUT' || method === 'PATCH') {
        const input = await mergeSchemaInput(sc, await body(req));
        delete input.degraded;
        const schema = await taskStore.changeSchema(method === 'PUT' ? 'replace' : 'patch', input, opts);
        broadcast({ type: 'schema', schema: null, actor });
        return send(res, 200, schemaFor(sc, schema));
      }
    }
    if (p === '/api/schema/restore' && method === 'POST') {
      // Explicitly accept the schema currently being served (after board.json was found broken).
      const schema = await schemaStore.restore();
      broadcast({ type: 'schema', schema: null, actor });
      return send(res, 200, schemaFor(sc, schema));
    }

    if (p === '/api/summary' && method === 'GET') {
      const [schema, all] = await Promise.all([schemaStore.get(), taskView.list()]);
      const tasks = all.filter(sc.isMine);
      const b = buckets(tasks, schema);
      const ids = (xs) => xs.map((x) => x.id);
      return send(res, 200, { today: today(), text: summaryText(tasks, schema), counts: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.length])), overdue: ids(b.overdue), todayIds: ids(b.today), active: ids(b.active), inbox: ids(b.inbox), reminders: b.reminders.map(({ task, reminder }) => ({ task: task.id, title: task.title, at: reminder.at, note: reminder.note })) });
    }

    if (p === '/api/tasks') {
      if (method === 'GET') {
        const [schema, tasks] = await Promise.all([schemaStore.get(), taskView.list({ includeArchived: url.searchParams.get('archived') === '1' })]);
        return send(res, 200, { items: filterTasks(tasks, schema, url.searchParams) });
      }
      if (method === 'POST') return send(res, 201, await taskView.create(await body(req), opts));
    }

    hit = m(/^\/api\/tasks\/(\d+)$/);
    if (hit) {
      if (method === 'GET') return send(res, 200, await taskView.get(hit[1]));
      if (method === 'PATCH') {
        const { org_reason: reason, ...changes } = await body(req);
        orgSync.setReason(hit[1], reason);
        return send(res, 200, await taskView.update(hit[1], changes, opts));
      }
      if (method === 'DELETE') return send(res, 200, await taskView.remove(hit[1], opts));
    }

    // ---- Team board link (optional) ----
    if (p === '/api/org' && method === 'GET') return send(res, 200, await orgSync.status(sc.user ?? people.defaultUser));
    if (p === '/api/org/sync' && method === 'POST') { await orgSync.pull(sc.user ?? people.defaultUser); return send(res, 200, await orgSync.status(sc.user ?? people.defaultUser)); }
    hit = m(/^\/api\/tasks\/(\d+)\/org$/);
    if (hit && method === 'POST') {
      await taskView.get(hit[1]); // visibility check
      const input = await body(req);
      const team = await orgSync.expose(sc.user ?? people.defaultUser, hit[1], { reviewer: input.reviewer });
      return send(res, 200, { task: await taskView.get(hit[1]), team });
    }

    hit = m(/^\/api\/tasks\/(\d+)\/steps$/);
    if (hit && method === 'POST') {
      const input = await body(req);
      return send(res, 200, await taskView.step(hit[1], { add: input.texts || input.text }, opts));
    }
    hit = m(/^\/api\/tasks\/(\d+)\/steps\/(\d+)$/);
    if (hit && (method === 'PATCH' || method === 'DELETE')) {
      const input = method === 'PATCH' ? await body(req) : { remove: true };
      return send(res, 200, await taskView.step(hit[1], { index: hit[2], ...input }, opts));
    }

    hit = m(/^\/api\/tasks\/(\d+)\/reminders$/);
    if (hit && method === 'POST') return send(res, 201, await taskView.addReminder(hit[1], await body(req), opts));
    hit = m(/^\/api\/tasks\/(\d+)\/reminders\/(r[a-z0-9]+)(\/snooze)?$/);
    if (hit) {
      if (method === 'DELETE' && !hit[3]) return send(res, 200, await taskView.changeReminder(hit[1], hit[2], null, opts));
      if (method === 'PATCH' && !hit[3]) return send(res, 200, await taskView.changeReminder(hit[1], hit[2], await body(req), opts));
      if (method === 'POST' && hit[3]) {
        const input = await body(req);
        const minutes = Number(input.minutes) || 60;
        // Snooze re-arms the reminder (even one that already fired) at the new time.
        return send(res, 200, await taskView.changeReminder(hit[1], hit[2], () => ({ at: input.at || new Date(Date.now() + minutes * 60_000).toISOString(), done: false }), opts));
      }
    }

    // ---- Schedule (לו״ז) ----
    if (p === '/api/schedule') {
      if (method === 'GET') return send(res, 200, { items: await eventView.list({ from: url.searchParams.get('from') || undefined, to: url.searchParams.get('to') || undefined }) });
      if (method === 'POST') return send(res, 201, (await eventView.create(await body(req), opts)).event);
    }
    hit = m(/^\/api\/schedule\/(e[a-z0-9]+)$/);
    if (hit) {
      if (method === 'GET') return send(res, 200, await eventView.get(hit[1]));
      if (method === 'PATCH') return send(res, 200, (await eventView.update(hit[1], await body(req), opts)).event);
      if (method === 'DELETE') return send(res, 200, await eventView.remove(hit[1], opts));
    }

    // ---- Shopping list (home space) ----
    if (p === '/api/shopping') {
      if (method === 'GET') return send(res, 200, await shopping.get(can, sc.user));
      if (method === 'POST') { const input = await body(req); return send(res, 201, { results: await shopping.add([].concat(input.items || input), { user: sc.user, can: canW, list: input.list || 'super' }) }); }
    }
    if (p === '/api/shopping/finish' && method === 'POST') { const input = await body(req); return send(res, 200, { finished: await shopping.finish(input.list || 'super', { can: canW }) }); }
    if (p === '/api/shopping/restore' && method === 'POST') { const input = await body(req); if (!Array.isArray(input.items)) throw fail(400, 'invalid', 'items must be an array'); return send(res, 200, { restored: await shopping.restore(input.items, { can: canW }) }); }
    hit = m(/^\/api\/shopping\/(s[a-z0-9]+)\/claim$/);
    if (hit && method === 'POST') { const input = await body(req); return send(res, 200, await shopping.claim(hit[1], sc.user, input.claimed !== false, { can })); }
    hit = m(/^\/api\/shopping\/(s[a-z0-9]+)$/);
    if (hit) {
      if (method === 'PATCH') return send(res, 200, await shopping.update(hit[1], await body(req), { can: canW }));
      if (method === 'DELETE') return send(res, 200, { removed: await shopping.remove(hit[1], { can: canW }) });
    }

    if (p === '/api/activity' && method === 'GET') return send(res, 200, { items: await taskView.activity({ limit: Math.min(Number(url.searchParams.get('limit')) || 50, 200), task: url.searchParams.get('task') || undefined }) });
    hit = m(/^\/api\/activity\/(a[a-z0-9]+)\/undo$/);
    if (hit && method === 'POST') {
      const result = await taskView.undo(hit[1], opts);
      if (result?.schema) { broadcast({ type: 'schema', schema: null, actor }); result.schema = schemaFor(sc, result.schema); }
      return send(res, 200, result);
    }

    if (p === '/api/notifications' && method === 'GET') return send(res, 200, { items: await scheduler.log(Math.min(Number(url.searchParams.get('limit')) || 20, 100), sc.user) });
    if (p === '/api/notifications/test' && method === 'POST') {
      // Fixed text only and rate-limited: this must never become a way to send arbitrary WhatsApp messages.
      if (Date.now() - lastTestAt < 60_000) throw fail(429, 'rate_limited', 'Test message already sent in the last minute');
      lastTestAt = Date.now();
      const result = await scheduler.deliver('✅ Workboard מחובר — תזכורות יגיעו לכאן.', { event_type: 'workboard.test', to: sc.user || people.defaultUser });
      return send(res, result.ok ? 200 : 502, result);
    }

    throw fail(method === 'GET' ? 404 : 405, method === 'GET' ? 'not_found' : 'method_not_allowed', 'Unknown endpoint');
  }

  const server = createHttpServer(async (req, res) => {
    try {
      if (!hostOk(req.headers.host)) return send(res, 421, { error: 'Unknown host', code: 'unknown_host' });
      const url = new URL(req.url, 'http://workboard.local');
      // Traffic from the public internet (Tailscale Funnel marks it) may only reach the inbound webhooks.
      if (req.headers['tailscale-funnel-request'] && !url.pathname.startsWith('/hooks/')) return send(res, 404, { error: 'Not found', code: 'not_found' });
      if (url.pathname.startsWith('/hooks/')) return await route(req, res, url);
      // Writes need a JSON content type (or a bearer token): browsers can't send that cross-site without a CORS
      // preflight, which is never granted — so other web pages can't use a paired device's cookie.
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && !isJson(req) && !req.headers.authorization) {
        return send(res, 415, { error: 'Send Content-Type: application/json', code: 'unsupported_media_type' });
      }
      return await route(req, res, url);
    } catch (error) {
      const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
      if (!res.headersSent) send(res, status, { error: error.message || 'Request failed', code: (typeof error.code === 'string' && !error.code.startsWith('E') ? error.code : null) || CODES[status] || 'error' });
      if (!error.status) console.error(error);
      return undefined;
    }
  });
  return { server, scheduler, taskStore, schemaStore, eventStore, auth, shopping, access, orgSync, pocket };
}

// Backwards-compatible helper used by tests.
export function createServer(options) { return createApp(options).server; }
