// Who sees what. The board holds several spaces in one store — each person's work and personal tasks, and a shared
// "home" space — and every caller (a paired device, an agent token) belongs to one person. All reads and writes go
// through a scoped view, so a task in a space you are not a member of behaves exactly like a task that doesn't exist.
// People and spaces live in <data>/people.json (no secrets there; tokens and webhooks stay in .env).
// Without that file the board is single-user: one person ("me", named by WORKBOARD_OWNER_NAME) with one work space.
// `defaultUser` / `defaultSpace` are where credentials and tasks without an explicit owner or space belong
// (older files call them legacyUser / legacySpace — still accepted).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const notFound = (message) => Object.assign(new Error(message), { status: 404, code: 'not_found' });
const forbidden = (message) => Object.assign(new Error(message), { status: 403, code: 'forbidden' });
const bad = (message) => Object.assign(new Error(message), { status: 400, code: 'invalid' });
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const SPACE_KINDS = ['work', 'personal', 'home'];

const DEFAULT = () => ({ users: [{ id: 'me', name: process.env.WORKBOARD_OWNER_NAME || 'אני' }], spaces: [{ id: 'work', label: 'עבודה', owner: 'me', kind: 'work' }], defaultSpace: 'work', defaultUser: 'me' });

export function validatePeople(input) {
  const legacy = { ...(input.legacyUser && !input.defaultUser && { defaultUser: input.legacyUser }), ...(input.legacySpace && !input.defaultSpace && { defaultSpace: input.legacySpace }) };
  const p = { ...DEFAULT(), ...input, ...legacy };
  if (!Array.isArray(p.users) || !p.users.length) throw new Error('people.json: users must be a non-empty array');
  const users = new Set();
  for (const u of p.users) { if (!ID.test(u.id || '') || users.has(u.id)) throw new Error(`people.json: bad or duplicate user id "${u.id}"`); users.add(u.id); }
  const spaces = new Set();
  for (const s of p.spaces) {
    if (!ID.test(s.id || '') || spaces.has(s.id)) throw new Error(`people.json: bad or duplicate space id "${s.id}"`);
    if (!SPACE_KINDS.includes(s.kind)) throw new Error(`people.json: space ${s.id} kind must be one of ${SPACE_KINDS.join(', ')}`);
    if (s.owner && !users.has(s.owner)) throw new Error(`people.json: space ${s.id} owner "${s.owner}" is not a user`);
    for (const m of s.members || []) if (!users.has(m)) throw new Error(`people.json: space ${s.id} member "${m}" is not a user`);
    if (!s.owner && !(s.members || []).length) throw new Error(`people.json: space ${s.id} needs an owner or members`);
    spaces.add(s.id);
  }
  if (!spaces.has(p.defaultSpace)) throw new Error(`people.json: defaultSpace "${p.defaultSpace}" is not a space`);
  if (!users.has(p.defaultUser)) throw new Error(`people.json: defaultUser "${p.defaultUser}" is not a user`);
  return p;
}

export function loadPeople(root) {
  let raw;
  try { raw = readFileSync(join(root, 'data', 'people.json'), 'utf8'); } catch { return validatePeople({}); }
  return validatePeople(JSON.parse(raw));
}

export function createAccess(people) {
  const spaceById = new Map(people.spaces.map((s) => [s.id, s]));
  const spaceOf = (task) => task?.space || people.defaultSpace;
  const ownerOfEvent = (e) => e?.owner || people.defaultUser;
  const members = (space) => (space.owner ? [space.owner, ...(space.members || [])] : space.members || []);
  const user = (id) => people.users.find((u) => u.id === id) || null;

  /** The scope of one caller. user null = maintenance token: everything. */
  function scope(userId) {
    const all = userId === null;
    const spaces = all ? people.spaces : people.spaces.filter((s) => members(s).includes(userId));
    const ids = new Set(spaces.map((s) => s.id));
    const can = (spaceId) => ids.has(spaceId);
    return {
      user: userId,
      all,
      spaces,
      canSeeTask: (task) => can(spaceOf(task)),
      canSeeEvent: (e) => all || ownerOfEvent(e) === userId || (e.owner === 'home' && spaces.some((s) => s.kind === 'home')),
      canSeeEntry: (a) => {
        if (all) return true;
        if (a.space) return can(a.space);
        if (a.owner) return a.owner === userId || (a.owner === 'home' && spaces.some((s) => s.kind === 'home'));
        // Structure changes carry the whole board.json (every project name): the board owner's only.
        if (a.action === 'schema') return userId === people.defaultUser;
        if (a.action === 'event') return ownerOfEvent(a.after?.event || a.before?.event) === userId;
        return can(people.defaultSpace); // entries written before spaces existed
      },
      /** "Mine to do": my own spaces, plus shared tasks assigned to me, to both, or to no one yet. */
      isMine: (task) => {
        const s = spaceById.get(spaceOf(task));
        if (!s || !can(s.id)) return false;
        if (s.owner) return all || s.owner === userId;
        return !task.assignee || task.assignee === 'both' || task.assignee === userId;
      },
      /** A space id, a kind relative to this person (work / personal / home), or a label → space id. */
      resolveSpace(value) {
        if (value === undefined || value === null || value === '') return undefined;
        const v = String(value).trim().toLowerCase();
        const alias = { 'עבודה': 'work', 'אישי': 'personal', 'פרטי': 'personal', 'בית': 'home', 'הבית': 'home', 'משותף': 'home', private: 'personal', life: 'personal', shared: 'home' }[v] || v;
        const hit = spaces.find((s) => s.id === v)
          || spaces.find((s) => s.kind === alias && (s.kind === 'home' || s.owner === userId))
          || spaces.find((s) => s.label === String(value).trim() && (s.kind === 'home' || s.owner === userId));
        if (!hit) throw bad(`Unknown space "${value}". Yours: ${spaces.map((s) => `${s.id} (${s.label})`).join(', ')}`);
        return hit.id;
      },
      defaultSpace: () => (all ? people.defaultSpace : (spaces.find((s) => s.owner === userId && s.kind === 'work') || spaces.find((s) => s.owner === userId) || spaces[0])?.id),
    };
  }

  return {
    people,
    users: people.users,
    user,
    multi: people.users.length > 1 || people.spaces.length > 1,
    space: (id) => spaceById.get(id) || null,
    spaceOf,
    ownerOfEvent,
    members,
    scope,
    /** Who gets a task reminder: who set it, else the space owner, else the assignee, else every member. */
    recipientsOfReminder(task, reminder) {
      if (reminder.to) return [reminder.to];
      const s = spaceById.get(spaceOf(task));
      if (!s) return [people.defaultUser];
      if (s.owner) return [s.owner];
      if (task.assignee && task.assignee !== 'both') return [task.assignee];
      return members(s);
    },
    recipientsOfEvent(e) {
      if (e.owner === 'home') return [...new Set(people.spaces.filter((s) => s.kind === 'home').flatMap(members))];
      return [ownerOfEvent(e)];
    },
    /** For the client: who I am, my spaces (labelled from my point of view) and the people I share with. */
    describe(userId) {
      const sc = scope(userId);
      const me = user(userId);
      return {
        me: me ? { id: me.id, name: me.name, gender: me.gender === 'f' ? 'f' : 'm', agent: me.agent || null, agentActor: me.agentActor || null } : null,
        people: people.users.map((u) => ({ id: u.id, name: u.name, agent: u.agent || null, agentActor: u.agentActor || null })),
        spaces: sc.spaces.map((s) => ({ id: s.id, kind: s.kind, label: s.owner && s.owner !== userId && userId !== null ? `${s.label} · ${user(s.owner)?.name || s.owner}` : s.label, owner: s.owner || null, color: s.color || null, shared: !s.owner })),
        multi: people.users.length > 1 || people.spaces.length > 1,
        defaultUser: people.defaultUser,
      };
    },
  };
}

/** The task store as one person sees it. Same API; invisible tasks are "not found". */
export function scopeTasks(store, sc, access) {
  const check = async (id) => { const t = await store.get(id); if (!sc.canSeeTask(t)) throw notFound(`Task ${id} not found`); return t; };
  const guardSpace = (changes) => {
    if (changes && typeof changes === 'object' && changes.space !== undefined && !sc.all && !sc.spaces.some((s) => s.id === changes.space)) throw forbidden(`No access to space "${changes.space}"`);
    return changes;
  };
  // A reminder set on a shared task goes to whoever set it, unless it names someone.
  const stampReminder = (task, input) => (sc.user && !access.space(access.spaceOf(task))?.owner && input && !input.to ? { ...input, to: sc.user } : input);
  return {
    ...store,
    scope: sc,
    async list(opts) { return (await store.list(opts)).filter(sc.canSeeTask); },
    get: check,
    create(input = {}, opts) {
      const space = input.space ?? sc.defaultSpace();
      guardSpace({ space });
      // On a shared space a new task is on whoever created it unless they said otherwise; its reminders go to them.
      const withTo = !access.space(space)?.owner && sc.user ? { ...input, ...(input.assignee === undefined && { assignee: sc.user }), reminders: (input.reminders || []).map((r) => (r.to ? r : { ...r, to: sc.user })) } : input;
      return store.create({ ...withTo, space }, opts);
    },
    async update(id, changes, opts) {
      await check(id);
      return store.update(id, typeof changes === 'function' ? async (t) => guardSpace(await changes(t)) : guardSpace(changes), opts);
    },
    async step(id, op, opts) { await check(id); return store.step(id, op, opts); },
    async addReminder(id, input, opts) { const t = await check(id); return store.addReminder(id, stampReminder(t, input), opts); },
    async changeReminder(id, rid, change, opts) { await check(id); return store.changeReminder(id, rid, change, opts); },
    async remove(id, opts) { await check(id); return store.remove(id, opts); },
    activity(opts = {}) { return store.activity({ ...opts, filter: sc.canSeeEntry }); },
    async undo(activityId, opts) {
      const entry = await store.activityEntry(activityId);
      if (!entry || !sc.canSeeEntry(entry)) throw notFound('Activity not found');
      if (entry.action === 'schema' && !sc.all && sc.user !== access.people.defaultUser) throw forbidden('Only the board owner can undo structure changes');
      return store.undo(activityId, opts);
    },
  };
}

/** The schedule as one person sees it: their own items (and shared home items). */
export function scopeEvents(store, sc, tasks) {
  const check = async (id) => { const e = await store.get(id); if (!sc.canSeeEvent(e)) throw notFound(`Event ${id} not found`); return e; };
  // Linking to a task you can't see is the same as linking to one that doesn't exist.
  const checkTask = async (input) => { if (input?.task !== undefined && input.task !== null && input.task !== '') { try { await tasks.get(String(input.task)); } catch { throw bad(`task #${input.task} does not exist`); } } };
  return {
    ...store,
    async list(opts) { return (await store.list(opts)).filter(sc.canSeeEvent); },
    get: check,
    async create(input, opts) {
      await checkTask(input);
      const home = sc.spaces.find((x) => x.kind === 'home')?.id;
      // An item's space: given, else a shared item is home's, else the linked task's, else my work.
      let space = input.space ?? null;
      if (!space && input.owner === 'home') space = home || null;
      if (!space && input.task) { try { space = (await tasks.get(String(input.task))).space || null; } catch { /* checked above */ } }
      if (space && !sc.all && !sc.spaces.some((x) => x.id === space)) throw forbidden(`No access to space "${space}"`);
      return store.create({ ...input, space: space || (sc.all ? null : sc.defaultSpace()), owner: input.owner === 'home' ? 'home' : (sc.user || input.owner || null) }, opts);
    },
    async update(id, input, opts) {
      await check(id); await checkTask(input);
      const { owner, ...rest } = input || {};
      if (rest.space && !sc.all && !sc.spaces.some((x) => x.id === rest.space)) throw forbidden(`No access to space "${rest.space}"`);
      return store.update(id, owner === 'home' || owner === sc.user ? { ...rest, owner } : rest, opts);
    },
    async remove(id, opts) { await check(id); return store.remove(id, opts); },
  };
}
