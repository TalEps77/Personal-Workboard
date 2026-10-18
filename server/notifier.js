// Delivers messages to a person's WhatsApp through their Hermes' webhook platform (route with deliver_only: true),
// i.e. Hermes' own send path — no LLM turn, no cron. Signed with HMAC-SHA256 (X-Webhook-Signature).
// Network errors/timeouts throw without `definite`: the outcome is unknown, so the caller retries with the SAME
// request id and Hermes' 1-hour idempotency cache turns an already-delivered retry into a no-op.
import { createHmac, randomUUID } from 'node:crypto';

// The default person's webhook: WORKBOARD_WEBHOOK_URL / WORKBOARD_WEBHOOK_SECRET (HERMES_WEBHOOK_* are older names).
export function createNotifier({ url = process.env.WORKBOARD_WEBHOOK_URL || process.env.HERMES_WEBHOOK_URL, secret = process.env.WORKBOARD_WEBHOOK_SECRET || process.env.HERMES_WEBHOOK_SECRET, fetchImpl = fetch } = {}) {
  return {
    configured: Boolean(url && secret),
    async send(message, meta = {}) {
      if (!url || !secret) throw new Error('Agent webhook is not configured (WORKBOARD_WEBHOOK_URL / WORKBOARD_WEBHOOK_SECRET)');
      const { to, ...rest } = meta;
      const body = JSON.stringify({ event_type: rest.event_type || 'workboard.notify', message, ...rest });
      const signature = createHmac('sha256', secret).update(body).digest('hex');
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': signature, 'x-request-id': rest.request_id || randomUUID() },
        body,
        signal: AbortSignal.timeout(8_000),
      });
      const text = await response.text();
      // A definite rejection: Hermes saw this request id, so a retry must use a new one.
      if (!response.ok) throw Object.assign(new Error(`Agent webhook answered ${response.status}: ${text.slice(0, 200)}`), { definite: true });
      // {"status":"duplicate"} means an earlier attempt with this id was already delivered — that's success.
      return text;
    },
  };
}

/**
 * One notifier per person: each person's own agent delivers to them. The original HERMES_WEBHOOK_URL/SECRET belong
 * to `defaultUser`; others come from WORKBOARD_WEBHOOKS="person|url|secret,…". `meta.to` picks the person.
 */
export function createNotifiers({ defaultUser = 'me', fallback = createNotifier(), spec = process.env.WORKBOARD_WEBHOOKS || '', fetchImpl = fetch } = {}) {
  const byUser = new Map([[defaultUser, fallback]]);
  for (const part of spec.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [user, url, secret] = part.split('|');
    if (user && url && secret) byUser.set(user, createNotifier({ url, secret, fetchImpl }));
  }
  const pick = (user) => byUser.get(user || defaultUser) || null;
  return {
    get configured() { return fallback.configured; },
    configuredFor: (user) => Boolean(pick(user)?.configured),
    async send(message, meta = {}) {
      const n = pick(meta.to);
      if (!n) throw Object.assign(new Error(`No WhatsApp delivery set up for "${meta.to}"`), { definite: true });
      return n.send(message, meta);
    },
  };
}
