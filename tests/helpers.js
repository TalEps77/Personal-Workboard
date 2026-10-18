import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';

export const AGENT_TOKEN = 'test-hermes-token';

/**
 * Boots an isolated board with a fake notifier. `call()` authenticates like the real clients:
 * actor 'agent' → the agent bearer token; otherwise → a paired dashboard session cookie; `anon: true` → no credentials.
 */
export async function boot({ notifier } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'workboard-test-'));
  const sent = [];
  const fake = notifier || { configured: true, send: async (message, meta) => { sent.push({ message, meta }); } };
  const app = createApp({ root, notifier: fake, schedulerInterval: 1e9, agentToken: AGENT_TOKEN });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const session = await app.auth.createSessionForTests();
  const call = async (path, { method = 'GET', body, actor, headers = {}, anon = false } = {}) => {
    const auth = anon ? {} : actor === 'agent' ? { authorization: `Bearer ${AGENT_TOKEN}` } : { cookie: `wb_session=${session}` };
    const res = await fetch(base + path, { method, headers: { ...(method !== 'GET' && { 'content-type': 'application/json' }), ...auth, ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { root, base, call, sent, app, session, close: async () => { app.scheduler.stop(); await new Promise((r) => app.server.close(r)); await rm(root, { recursive: true, force: true }); } };
}
