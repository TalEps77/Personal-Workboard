// Optional: connects a person's work space to a team board (Workboard org) — two-way, per person.
//   WORKBOARD_ORG_URL     https://team-board.example        the team board
//   WORKBOARD_ORG_TOKENS  "person|token,…"                    each person's SYNC token from the team board's Settings
//   WORKBOARD_ORG_TOKEN   token                               shorthand for the default person
// Team tasks the person is responsible for or reviews (or chose to mirror) appear in their work space, marked with
// `org`. The team board is the source of truth: its changes always land here. Changes made here (status, due date,
// title, notes) are sent back; if the team board refuses one (no permission, a due date moved without a reason), the
// local value is put back and the activity log says why. A personal task can be "exposed" to the team board — from
// then on it is a team task. Private tasks never leave unless exposed.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './fs-util.js';

const FIELDS = ['title', 'notes', 'deadline', 'status', 'archived'];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export const ORG_ACTOR = 'org-sync';

export function parseOrgTokens(spec = '', single = '', defaultUser = 'me') {
  const out = new Map();
  if (single) out.set(defaultUser, single);
  for (const part of String(spec).split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf('|');
    if (i > 0) out.set(part.slice(0, i), part.slice(i + 1));
  }
  return out;
}

export function createOrgSync({
  root, taskStore, schemaStore, people,
  url = process.env.WORKBOARD_ORG_URL || '',
  tokens = parseOrgTokens(process.env.WORKBOARD_ORG_TOKENS, process.env.WORKBOARD_ORG_TOKEN, people.defaultUser),
  interval = Number(process.env.WORKBOARD_ORG_POLL_SECONDS || 60) * 1000,
  fetchImpl = fetch, log = console,
} = {}) {
  const base = String(url).replace(/\/$/, '');
  const statePath = join(root, 'data', 'runtime', 'org-sync.json');
  const reasons = new Map(); // local task id → reason for the next due-date move
  const queue = new Map(); // local task id → pending push
  const running = new Map(); // user → Promise (one pull at a time per person)
  let state = null; let timer = null;
  const enabled = Boolean(base) && tokens.size > 0;

  const loadState = async () => { if (!state) { try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch { state = {}; } } return state; };
  const saveState = () => writeAtomic(statePath, JSON.stringify(state, null, 2));

  async function call(user, method, path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method, signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${tokens.get(user)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || `team board answered ${res.status}`), { status: res.status, code: data.error });
    return data;
  }

  /** The person's own work space (null = the original work board). */
  function workSpace(user) {
    const s = people.spaces.find((x) => x.owner === user && x.kind === 'work') || people.spaces.find((x) => x.kind === 'work');
    return !s || s.id === people.defaultSpace ? null : s.id;
  }

  // ---- status mapping (by category, so a customised status list keeps working)
  function localStatus(schema, orgStatus) {
    const byCat = (cat) => schema.statuses.find((s) => s.category === cat)?.id;
    switch (orgStatus) {
      case 'pending': return byCat('inbox') || byCat('todo');
      case 'open': return schema.statuses.find((s) => s.id === schema.defaultStatus && s.category === 'todo')?.id || byCat('todo');
      case 'doing': return schema.statuses.find((s) => s.category === 'active' && s.id !== 'waiting')?.id || byCat('active');
      case 'blocked': return schema.statuses.find((s) => s.id === 'waiting')?.id || byCat('active');
      default: return byCat('done');
    }
  }
  function orgStatus(schema, local) {
    const s = schema.statuses.find((x) => x.id === local);
    if (!s) return null;
    if (s.category === 'done') return 'done';
    if (s.category === 'active') return s.id === 'waiting' ? 'blocked' : 'doing';
    return 'open';
  }

  function wanted(schema, t) {
    return { title: t.title, notes: t.description || '', deadline: t.due || null, status: localStatus(schema, t.status), archived: ['rejected', 'canceled'].includes(t.status) };
  }
  const roleOf = (t, meId) => (t.responsible?.id === meId ? 'responsible' : t.reviewer?.id === meId ? 'reviewer' : 'watching');
  function meta(user, role, t, snap) {
    return { id: t.id, user, url: `${base}/#/t/${t.id}`, role, status: t.status, rev: t.rev, responsible: t.responsible?.name || null, reviewer: t.reviewer?.name || null, slips: t.slips || 0, snap };
  }

  /** Pull everything that changed on the team board for one person. */
  async function pull(user) {
    if (running.has(user)) return running.get(user);
    const p = (async () => {
      await loadState();
      const st = state[user] || {};
      try {
        const res = await call(user, 'GET', `/api/sync?since=${st.cursor || 0}`);
        const schema = await schemaStore.get();
        const all = await taskStore.list({ includeArchived: true });
        const mine = new Map(all.filter((t) => t.org && t.org.user === user).map((t) => [t.org.id, t]));
        for (const t of res.tasks) {
          const want = wanted(schema, t);
          const local = mine.get(t.id);
          if (!local) {
            await taskStore.create({ ...want, space: workSpace(user), org: meta(user, roleOf(t, res.me?.id), t, want) }, { actor: ORG_ACTOR });
            continue;
          }
          // The team board wins on every field it changed since the last sync.
          const changes = {};
          for (const k of FIELDS) if (!same(local.org.snap?.[k], want[k]) && !same(local[k], want[k])) changes[k] = want[k];
          await taskStore.update(local.id, { ...changes, org: meta(user, roleOf(t, res.me?.id), t, want) }, { actor: ORG_ACTOR, summaryPrefix: 'מהלוח הארגוני: ' });
        }
        for (const id of res.gone) {
          const local = mine.get(id);
          if (local && !local.org.gone) await taskStore.update(local.id, { archived: true, org: { ...local.org, gone: true } }, { actor: ORG_ACTOR, summaryPrefix: 'כבר לא אצלך בלוח הארגוני · ' });
        }
        state[user] = { cursor: res.cursor, ok_at: new Date().toISOString(), error: null, name: res.me?.name || null };
      } catch (error) {
        state[user] = { ...st, error: error.message, error_at: new Date().toISOString() };
        log.error(`[org-sync] ${user}: ${error.message}`);
      }
      await saveState();
    })().finally(() => running.delete(user));
    running.set(user, p);
    return p;
  }

  /** Sends local edits of a mirrored task back to the team board. */
  async function push(localId) {
    let t; try { t = await taskStore.get(localId); } catch { return; }
    const o = t.org;
    if (!o || o.gone || !tokens.has(o.user)) return;
    const schema = await schemaStore.get();
    const snap = o.snap || {};
    const patch = {}; const reverted = {};
    if (t.title !== snap.title) { patch.title = t.title; reverted.title = snap.title; }
    if ((t.notes || '') !== (snap.notes || '')) { patch.description = t.notes || ''; reverted.notes = snap.notes; }
    if ((t.deadline || null) !== (snap.deadline || null)) { patch.due = t.deadline || null; patch.reason = reasons.get(localId) || ''; reverted.deadline = snap.deadline; }
    if (t.status !== snap.status) {
      const next = orgStatus(schema, t.status);
      if (next && next !== o.status) {
        patch.status = next; reverted.status = snap.status;
        if (next === 'blocked') patch.note = 'ממתין (עודכן מהמערכת האישית)';
      }
    }
    reasons.delete(localId);
    if (!Object.keys(patch).length) {
      // Only local-side differences that have no team-board meaning (e.g. two local statuses of one category).
      if (!same(snap, { title: t.title, notes: t.notes, deadline: t.deadline, status: t.status, archived: t.archived })) {
        await taskStore.update(localId, { org: { ...o, snap: { ...snap, title: t.title, notes: t.notes, deadline: t.deadline, status: t.status } } }, { actor: ORG_ACTOR });
      }
      return;
    }
    try {
      const { task } = await call(o.user, 'PATCH', `/api/tasks/${o.id}`, patch);
      const want = wanted(schema, task);
      // Keep a finer local status (e.g. "waiting" vs "doing") when it maps to the same team status.
      const keep = orgStatus(schema, t.status) === task.status ? t.status : want.status;
      await taskStore.update(localId, { status: keep, org: meta(o.user, o.role, task, { ...want, status: keep }) }, { actor: ORG_ACTOR });
    } catch (error) {
      const why = error.code === 'reason_required' ? 'הזזת יעד של משימה ארגונית דורשת סיבה' : error.message;
      await taskStore.update(localId, reverted, { actor: ORG_ACTOR, summaryPrefix: `הלוח הארגוני לא קיבל את השינוי (${why}) · ` }).catch(() => {});
      log.error(`[org-sync] push #${localId}: ${error.message}`);
    }
  }

  return {
    enabled,
    url: base,
    configuredFor: (user) => enabled && tokens.has(user),
    /** Called for every task change; pushes edits of mirrored tasks (not the sync's own writes). */
    onChange(event) {
      if (!enabled || event.type !== 'task' || !event.task?.org || !event.activity || event.activity.actor === ORG_ACTOR) return;
      const id = event.task.id;
      clearTimeout(queue.get(id));
      queue.set(id, setTimeout(() => { queue.delete(id); push(id); }, 300));
    },
    /** The next due-date move of this task carries this reason to the team board. */
    setReason(localId, reason) { if (reason) reasons.set(String(localId), String(reason).slice(0, 500)); },
    async status(user) { await loadState(); return { enabled: enabled && tokens.has(user), url: base, ...(state[user] || {}) }; },
    pull, pullAll: () => Promise.all([...tokens.keys()].map(pull)),
    /** Turns a personal task into a team task (one way) and links it. */
    async expose(user, localId, { reviewer } = {}) {
      if (!tokens.has(user)) throw Object.assign(new Error('This person has no team board connection'), { status: 400, code: 'invalid' });
      const t = await taskStore.get(localId);
      if (t.org) throw Object.assign(new Error('Already on the team board'), { status: 409, code: 'conflict' });
      const body = { title: t.title, description: t.notes || '', due: t.deadline || null, origin: 'personal', ...(reviewer ? { reviewer } : {}) };
      const { task } = await call(user, 'POST', '/api/tasks', body);
      const schema = await schemaStore.get();
      const want = { ...wanted(schema, task), status: t.status };
      await taskStore.update(localId, { space: workSpace(user) ?? t.space, org: meta(user, 'responsible', task, want) }, { actor: ORG_ACTOR, summaryPrefix: 'נחשפה ללוח הארגוני · ' });
      if (orgStatus(schema, t.status) !== task.status) await push(localId);
      return task;
    },
    start() {
      if (!enabled || timer) return;
      this.pullAll();
      timer = setInterval(() => this.pullAll(), interval);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; for (const t of queue.values()) clearTimeout(t); queue.clear(); },
  };
}
