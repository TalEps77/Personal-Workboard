// Who may use the board.
//  • Agents: static bearer tokens (see "Credentials" below). The activity actor comes from the credential, never a
//    header. Every credential belongs to one person, and that decides which spaces it sees (server/access.js).
//  • Browsers: a device must be paired once. It asks for a 6-digit code, the code goes to that person's WhatsApp (via the
//    same agent webhook as reminders), and entering it sets a long-lived HttpOnly cookie. Being on the same network
//    or tailnet is never enough on its own.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLock, writeAtomic } from './fs-util.js';

const COOKIE = 'wb_session';
const SESSION_DAYS = 400; // browsers cap cookie lifetime at 400 days
const CODE_TTL_MS = 10 * 60_000;
const CODE_ATTEMPTS = 5;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const safeEqual = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function deviceLabel(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'מכשיר';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) && !/Edg\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  const standalone = /Mobile\//.test(ua) && !/Safari\//.test(ua) ? ' (אפליקציה)' : '';
  return `${os}${browser ? ` · ${browser}` : ''}${standalone}`;
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => p.trim().split('=')).filter(([k, v]) => k && v).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

// Credentials (all in .env):
//   WORKBOARD_AGENT_TOKENS = "person:actor:token,…"  one per person's agent (actor = how it appears in the activity log)
//   WORKBOARD_AGENT_TOKEN  = a token for the default person's agent (its actor = that person's agentActor, or "agent")
//   WORKBOARD_SERVICE_TOKENS = "actor:token,…"        maintenance tools that see every space
// Older names still work: HERMES_API_TOKEN (= WORKBOARD_AGENT_TOKEN), WORKBOARD_AGENTS, WORKBOARD_EXTRA_TOKENS.
export function createAuth({ root, agentToken = process.env.WORKBOARD_AGENT_TOKEN || process.env.HERMES_API_TOKEN, extraTokens = process.env.WORKBOARD_SERVICE_TOKENS || process.env.WORKBOARD_EXTRA_TOKENS || '', agentTokens = process.env.WORKBOARD_AGENT_TOKENS || process.env.WORKBOARD_AGENTS || '', people = { users: [{ id: 'me' }], defaultUser: 'me' }, disabled = false, sendCode } = {}) {
  const defaultActor = String(people.users.find((u) => u.id === people.defaultUser)?.agentActor || 'agent').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'agent';
  const defaultUser = people.defaultUser;
  const isUser = (id) => people.users.some((u) => u.id === id);
  const agents = agentTokens.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [user, actor, ...rest] = x.split(':'); return { user, actor: String(actor || '').replace(/[^a-z0-9_-]/gi, '').toLowerCase(), hash: sha(rest.join(':')) }; }).filter((x) => x.actor && isUser(x.user) && !x.actor.startsWith('dashboard'));
  // Named service tokens ("maintenance:<token>,…") so maintenance tools are attributed honestly in the activity log.
  const named = extraTokens.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const i = x.indexOf(':'); return { actor: x.slice(0, i).replace(/[^a-z0-9_-]/gi, '').toLowerCase(), hash: sha(x.slice(i + 1)) }; }).filter((x) => x.actor && !x.actor.startsWith('dashboard'));
  const path = join(root, 'data', 'runtime', 'sessions.json');
  const lock = createLock();
  const pending = new Map(); // person → { hash, expires, attempts, device }
  const lastCodeAt = new Map();
  const codeTimes = [];

  const load = async () => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return { sessions: [] }; } };
  const save = (db) => writeAtomic(path, JSON.stringify(db, null, 2));

  async function sessionFor(token) {
    if (!token) return null;
    const db = await load();
    const s = db.sessions.find((x) => safeEqual(x.hash, sha(token)));
    if (!s || Date.parse(s.expires) < Date.now()) return null;
    // Touch at most once an hour to avoid a write per request.
    if (Date.now() - Date.parse(s.last_seen || 0) > 3600_000) {
      lock(async () => { const d = await load(); const t = d.sessions.find((x) => x.id === s.id); if (t) { t.last_seen = new Date().toISOString(); await save(d); } }).catch(() => {});
    }
    return s;
  }

  return {
    COOKIE,
    disabled,
    agentConfigured: Boolean(agentToken),

    /** Resolves the caller: { actor, kind, session? } or null when unauthenticated. */
    async identify(req) {
      if (disabled) {
        const u = isUser(String(req.headers['x-user'] || '')) ? String(req.headers['x-user']) : defaultUser;
        const dash = u === defaultUser ? 'dashboard' : `dashboard-${u}`;
        return { actor: String(req.headers['x-actor'] || dash).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20) || dash, kind: 'dev', user: u };
      }
      const bearer = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
      if (bearer && agentToken && safeEqual(sha(bearer), sha(agentToken))) return { actor: defaultActor, kind: 'token', user: defaultUser };
      const agent = bearer && agents.find((x) => safeEqual(sha(bearer), x.hash));
      if (agent) return { actor: agent.actor, kind: 'token', user: agent.user };
      // Maintenance tokens see every space.
      const other = bearer && named.find((x) => safeEqual(sha(bearer), x.hash));
      if (other) return { actor: other.actor, kind: 'token', user: null };
      const session = await sessionFor(parseCookies(req.headers.cookie)[COOKIE]);
      if (!session) return null;
      // The owner's devices are "dashboard" (as always); another person's are "dashboard-<person>", so the activity
      // log and live toasts can say who changed a shared task.
      const user = isUser(session.user) ? session.user : defaultUser;
      return { actor: user === defaultUser ? 'dashboard' : `dashboard-${user}`, kind: 'session', session, user };
    },

    /** Sends a pairing code to that person's WhatsApp. Throttled: 1/minute per person, 5/hour overall. */
    async requestCode(device, user = defaultUser) {
      if (!isUser(user)) throw Object.assign(new Error('Unknown person'), { status: 400, code: 'invalid' });
      const now = Date.now();
      while (codeTimes.length && now - codeTimes[0] > 3600_000) codeTimes.shift();
      if (now - (lastCodeAt.get(user) || 0) < 60_000) throw Object.assign(new Error('כבר נשלח קוד — אפשר לבקש שוב בעוד דקה'), { status: 429, code: 'rate_limited' });
      if (codeTimes.length >= 5) throw Object.assign(new Error('יותר מדי בקשות קוד בשעה האחרונה'), { status: 429, code: 'rate_limited' });
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      pending.set(user, { hash: sha(code), expires: now + CODE_TTL_MS, attempts: 0, device });
      lastCodeAt.set(user, now); codeTimes.push(now);
      // Fallback when WhatsApp is down: the code is also in `docker logs workboard` (host access only).
      console.log(`[auth] pairing code for "${device}": ${code} (valid 10 min)`);
      try {
        await sendCode(`🔐 *קוד חיבור ל־Workboard:* ${code}\nמכשיר: ${device}\nבתוקף 10 דקות. לא ביקשת? פשוט להתעלם.`, user);
        return { sent: true };
      } catch (error) {
        console.error(`[auth] could not send pairing code to WhatsApp: ${error.message}`);
        return { sent: false };
      }
    },

    /** Verifies the code and returns a new session token (to be set as cookie). */
    verify(code, device, user = defaultUser) {
      return lock(async () => {
        const p = pending.get(user);
        if (!p || Date.now() > p.expires) throw Object.assign(new Error('אין קוד בתוקף — בקש קוד חדש'), { status: 400, code: 'no_code' });
        p.attempts += 1;
        if (p.attempts > CODE_ATTEMPTS) { pending.delete(user); throw Object.assign(new Error('יותר מדי ניסיונות — בקש קוד חדש'), { status: 429, code: 'rate_limited' }); }
        if (!safeEqual(sha(String(code).trim()), p.hash)) throw Object.assign(new Error('קוד שגוי'), { status: 400, code: 'bad_code' });
        // Name the session after the device that asked for the code.
        device = p.device || device;
        pending.delete(user);
        const token = randomBytes(32).toString('base64url');
        const db = await load();
        const now = new Date();
        db.sessions.push({ id: randomBytes(6).toString('hex'), hash: sha(token), user, device, created_at: now.toISOString(), last_seen: now.toISOString(), expires: new Date(now.getTime() + SESSION_DAYS * 86400_000).toISOString() });
        await save(db);
        return { token, maxAge: SESSION_DAYS * 86400 };
      });
    },

    /** Paired devices; with `user`, only that person's (sessions from before there were several people are the owner's). */
    async list(user = undefined) {
      return (await load()).sessions.filter((s) => user === undefined || user === null || (s.user || defaultUser) === user).map(({ hash, ...s }) => ({ ...s, user: s.user || defaultUser }));
    },

    revoke(id) {
      return lock(async () => {
        const db = await load();
        const before = db.sessions.length;
        db.sessions = db.sessions.filter((s) => s.id !== id);
        await save(db);
        return { ok: true, removed: before - db.sessions.length };
      });
    },

    /** Test helper: create a session without the WhatsApp round trip. */
    async createSessionForTests(device = 'test', user = defaultUser) {
      pending.set(user, { hash: sha('000000'), expires: Date.now() + 60_000, attempts: 0, device });
      return (await this.verify('000000', device, user)).token;
    },
  };
}
