# Connecting an AI agent (Hermes)

Workboard is designed to be operated by an AI agent. [Hermes](https://github.com/NousResearch/hermes-agent) talks to
people over WhatsApp and uses Workboard's MCP tools to read and change the board. Workboard talks back through a
signed webhook, so reminders, the morning digest and dashboard pairing codes arrive on WhatsApp.

Nothing here is Hermes-specific on the Workboard side: any MCP client can use `POST /mcp`, and any HTTP endpoint
that verifies the signature below can receive messages.

## How it works

```text
            WhatsApp message                         MCP tools (JSON-RPC over HTTP)
 person  ⇄  ────────────────►  Hermes  ⇄  ─────────────────────────────────────►  Workboard
 (phone)    ◄────────────────  (agent)     POST http://workboard:3000/mcp          (tasks, schedule,
                                              Authorization: Bearer <agent token>     shopping, reminders)
                                  ▲
                                  │  POST http://hermes:8644/webhooks/workboard
                                  │  X-Webhook-Signature: HMAC-SHA256(body)
                                  └──────────────  signed webhook  ◄─────────────  Workboard scheduler
                                    (deliver_only: no LLM turn)                    reminder / event / digest / pairing
```

- **Agent to board:** the agent calls typed tools (`board`, `find_tasks`, `create_tasks`, ...). Dates are resolved
  by the server, answers are short Hebrew text. The credential decides which person (and therefore which spaces)
  the agent acts for. See [tools.md](tools.md) for the tool reference.
- **Board to person:** Workboard owns reminders. Its scheduler sends the text to the agent's webhook, and Hermes
  forwards it to WhatsApp as-is. The agent never needs a cron job or a model call for this.

## Prerequisites

- Workboard running (see the main README), with a TLS reverse proxy if you want the dashboard reachable outside the host.
- A Hermes instance with the WhatsApp platform paired to a phone number.
- Workboard and Hermes can reach each other over a Docker network (Step 4) or any other private network.
- `openssl` for generating secrets.

## Step 1: create tokens

Each agent gets its own token, bound to one person from `data/people.json`:

```bash
openssl rand -hex 32     # agent token
openssl rand -hex 32     # webhook secret
```

In Workboard's `.env`:

```bash
# person-id:actor:token. The person id must exist in people.json; the actor is the name shown in the activity log.
WORKBOARD_AGENT_TOKENS=alex:hermes:<agent token>
```

Single-user setups without `people.json` can use `WORKBOARD_AGENT_TOKEN=<token>` instead (the agent acts for the
default person).

Credential variables at a glance:

| Variable | Format | Sees |
| --- | --- | --- |
| `WORKBOARD_AGENT_TOKENS` | `person:actor:token,person:actor:token` | that person's spaces |
| `WORKBOARD_AGENT_TOKEN` | `token` | the default person's spaces |
| `WORKBOARD_SERVICE_TOKENS` | `actor:token,...` | every space (maintenance tools, scripts) |

Older names (`HERMES_API_TOKEN`, `WORKBOARD_AGENTS`, `WORKBOARD_EXTRA_TOKENS`) still work. Actors are lower-cased and
limited to `a-z 0-9 _ -`; actors starting with `dashboard` are rejected (reserved for browsers).

## Step 2: tell Hermes about Workboard

Hermes `config.yaml`:

```yaml
mcp_servers:
  workboard:
    url: http://workboard:3000/mcp
    headers:
      Authorization: "Bearer ${WORKBOARD_TOKEN}"
```

Hermes `.env` (the same token as in Workboard's `WORKBOARD_AGENT_TOKENS`):

```bash
WORKBOARD_TOKEN=<agent token>
```

The endpoint is stateless MCP over HTTP: `POST` only, one JSON-RPC message or a batch per request. The agent sees the
tools as `mcp_workboard_*`. The full fragment is in [`integrations/hermes/config.example.yaml`](../integrations/hermes/config.example.yaml).

## Step 3: delivery (Workboard to WhatsApp)

Add a webhook route to Hermes' `config.yaml`:

```yaml
platforms:
  webhook:
    enabled: true
    extra:
      host: 0.0.0.0
      port: 8644
      routes:
        workboard:
          secret: "<webhook secret>"
          deliver_only: true     # forward the text, do not run the model
          deliver: whatsapp      # to the agent's WhatsApp home channel
          prompt: '{message}'
```

Then in Workboard's `.env`:

```bash
WORKBOARD_WEBHOOK_URL=http://hermes:8644/webhooks/workboard
WORKBOARD_WEBHOOK_SECRET=<webhook secret>      # identical to the route's secret
```

These two variables belong to the **default person** in `people.json`. Other people use `WORKBOARD_WEBHOOKS`
(see [Multiple people](#multiple-people)). Older `HERMES_WEBHOOK_URL` / `HERMES_WEBHOOK_SECRET` still work.

Restart Hermes after editing `config.yaml`.

## Step 4: Docker networking

Workboard and Hermes must resolve each other by name. If Hermes runs in its own compose project, join Workboard to
that network with a compose override kept next to your `.env`
([`examples/compose.override.yml`](../examples/compose.override.yml)):

```yaml
services:
  workboard:
    networks: [default, agent]
networks:
  agent:
    name: hermes_default     # the network Hermes is on: docker network ls
    external: true
```

```bash
docker compose -f compose.yml -f /path/to/compose.override.yml --env-file /path/to/.env up -d
```

Also make sure Workboard's `WORKBOARD_HOSTS` contains the host name the agent uses (`workboard:3000,workboard`);
requests with an unknown `Host` header get `421`.

## Step 5: install the agent skill

The skill teaches the agent the tool vocabulary, date words, spaces, shopping lists and reply style.

```bash
cp integrations/hermes/SKILL.md "$HERMES_HOME/skills/productivity/workboard/SKILL.md"   # create the directory first
```

Start a new Hermes session (or restart) so the skill is picked up. If you run the agent in the user's language, keep
the skill as is: the tool vocabulary is Hebrew-first, but the instructions are in English.

## Step 6: verify

1. Check the network: `docker exec hermes curl -s http://workboard:3000/api/health` should print `{"ok":true,...}`.
2. In the dashboard open Settings and press **send test message**. A "Workboard connected" message should arrive on
   WhatsApp (fixed text, at most once a minute).
3. Message the agent on WhatsApp: **"מה יש לי היום?"**. It should call `board` and answer with today's agenda.
4. Create a task with a reminder a few minutes ahead and wait for it. The Settings page lists recent deliveries
   (`GET /api/notifications`) and marks failures in red.

## Multiple people

Run **one agent per person**. Each person has their own Hermes instance (separate container, config, `.env`,
credentials), their own token mapped to their person id, and their own webhook.

Workboard side:

```bash
WORKBOARD_AGENT_TOKENS=alex:hermes:<token-a>,sam:nova:<token-b>

# default person (alex):
WORKBOARD_WEBHOOK_URL=http://hermes:8644/webhooks/workboard
WORKBOARD_WEBHOOK_SECRET=<secret-a>
# everyone else: person|url|secret, comma separated
WORKBOARD_WEBHOOKS=sam|http://nova:8644/webhooks/workboard|<secret-b>
```

Each agent sees only its person's spaces (see `people.json`: personal and work spaces belong to one person, `home`
is shared). A reminder is delivered by the agent of whoever should receive it; tasks and schedule items in a shared
space can notify several people.

Hermes side, per instance:

- Separate `config.yaml`, `.env` and `HERMES_HOME`. Give each its own `WORKBOARD_TOKEN`.
- **Same WhatsApp number, two agents.** Both agents can be linked devices of one number. Set
  `WHATSAPP_ALLOWED_USERS` in each instance to its owner's number so it ignores the other person. In groups use
  `require_mention: true` plus `mention_patterns` (the agent's name) so each agent answers only when addressed.
- **Never share an OAuth credential file between two agents** (for example the model provider's login). Refresh
  tokens rotate on use, so whichever agent refreshes second invalidates the other, and one of them gets logged out.
  Give each instance its own login.

## Webhook contract

Workboard sends every message with one HTTP request. Any receiver that follows this contract works, not only Hermes.

```http
POST <your webhook url>
Content-Type: application/json
X-Webhook-Signature: <hex HMAC-SHA256 of the raw request body, key = the shared secret>
X-Request-Id: <idempotency key>

{"event_type":"workboard.reminder","message":"...","task":12,"reminder":"r3","title":"Call the plumber","request_id":"wb-12-r3-1760000000000-0"}
```

- The signature covers the **exact raw bytes** of the body. Verify before parsing, with a constant-time comparison.
- The body is JSON: `event_type`, `message` (ready-to-send WhatsApp text, Hebrew, WhatsApp markdown), plus the
  fields below. `request_id` repeats the `X-Request-Id` header. The recipient (`to`) is not sent: each person has
  their own URL and secret.
- Timeout is 8 seconds.

| `event_type` | When | Extra fields |
| --- | --- | --- |
| `workboard.reminder` | A task reminder is due (one-off, repeating or nag) | `task` (id), `reminder` (id), `title` |
| `workboard.event` | Heads-up before a schedule item (meeting, work block) | `event` (id), `task` (id or null), `title` |
| `workboard.digest` | Morning digest, if enabled in Settings | none |
| `workboard.pairing` | Six-digit code to pair a browser; valid 10 minutes | none |
| `workboard.test` | The "send test message" button | none |

Other event types may be added later: treat unknown ones as plain text delivery.

Verify in Node:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody /* Buffer */, header, secret) {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(header || '');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Verify in Python:

```python
import hmac, hashlib

def verify(raw_body: bytes, header: str, secret: str) -> bool:
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header or "")
```

### Idempotency and retries

- Every message carries a stable `X-Request-Id` (for reminders: task, reminder, scheduled time and a rejection
  counter). Receivers should remember ids for about an hour and answer a repeat with `200` without delivering again
  (Hermes replies `{"status":"duplicate"}`; Workboard treats any 2xx as delivered).
- **Network errors and timeouts** (connection refused, reset, 8 s timeout) leave the outcome unknown. Workboard retries
  with the **same** request id, so a message that actually went through is not delivered twice.
- **A non-2xx response is a definite rejection.** The receiver saw the request and refused it, so the retry uses a
  **new** request id (the id's last part increments).
- Retry schedule for reminders: 2, 4, 8, ... minutes, capped at one hour, up to 8 attempts or 24 hours after the due
  time, then the reminder is marked "not delivered" (shown in red on the dashboard and listed by the `board` tool).
  Schedule heads-ups retry every 2 minutes until the item ends. The morning digest retries every 10 minutes
  and is dropped if more than 3 hours late. Pairing codes and test messages are not retried.
- Reminders more than 10 minutes late are labeled as late in the text.

## Security notes

- A token acts as one person: it sees exactly the spaces that person belongs to; tasks in other spaces behave as
  if they do not exist. Do not give an agent a service token.
- `WORKBOARD_SERVICE_TOKENS` see **every** space. Use them only for your own maintenance scripts.
- Tokens and secrets live in `.env` files (mode 600, never committed). Workboard stores only hashes of sessions
  and compares tokens in constant time.
- Keep the webhook port unpublished: only the Workboard container needs to reach it, and the signature protects
  it from anyone else on the network.
- Rotate: generate a new value with `openssl rand -hex 32`, update both sides (token: Workboard `.env` and the
  agent's `.env`; webhook secret: Workboard `.env` and the Hermes route), then restart both containers.
- The test-message endpoint sends fixed text and is rate limited, so it cannot be used to send arbitrary messages.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Agent gets `401 unauthorized` | Token missing or mistyped, or the person id in `WORKBOARD_AGENT_TOKENS` is not in `people.json` (such entries are silently ignored). Restart Workboard after editing `.env`, and check that `${WORKBOARD_TOKEN}` is set in Hermes' environment. |
| `421 Unknown host` | The host name the agent uses is not in `WORKBOARD_HOSTS`. |
| Agent cannot reach `workboard:3000` | The containers are not on a shared network (Step 4). Test with `docker exec hermes curl http://workboard:3000/api/health`. |
| Webhook answered `401`/`403` (shown in Settings or `notifications.jsonl`) | Secret mismatch between `WORKBOARD_WEBHOOK_SECRET` and the Hermes route. They must be byte-identical, and Hermes needs a restart after editing the route. |
| Webhook answered `404` | The route name differs from the URL path (`/webhooks/<route>`), or the webhook platform is not enabled. |
| Webhook answered `5xx` or times out | Hermes is down or its WhatsApp session is disconnected. Workboard keeps retrying (see above). |
| Agent does not see new tools after an upgrade | Hermes lists MCP tools at startup. Restart the agent so it lists them again. |
| WhatsApp messages ignored, log says `Unauthorized user ...@lid` | WhatsApp sends some senders as LIDs. The gateway resolves them from `$HERMES_HOME/whatsapp/session`, while the bridge may keep the session under `$HERMES_HOME/platforms/whatsapp/session`. Symlink one to the other (the directory that actually holds the files), restart Hermes, and check `WHATSAPP_ALLOWED_USERS`. |
| Pairing code never arrives | Same path as reminders: check the webhook first. The code is also written to Workboard's container log as a fallback. |
| Agent says it set a reminder but nothing arrives | Ask it to call `board`: undelivered reminders are listed there. Quiet hours only delay repeat "nag" reminders, never explicit times. |
