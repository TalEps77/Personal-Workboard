# Architecture

Workboard is one Node 22 process with no npm dependencies. It serves a static single-page app (vanilla ES modules, no build step), a JSON API, a live event stream (SSE) and an MCP endpoint for AI agents. All state lives in plain files under `data/`.

## Design principles

| Principle | What it means in the code |
|---|---|
| Zero dependencies | `package.json` has no `dependencies`. The server uses only `node:*` modules; the client is hand-written ES modules and CSS. The fonts are served from the repo. No CDN, no bundler. |
| Files are the database | One task is one Markdown file. Structure, people, schedule and shopping are small JSON files. You can read, diff, back up and hand-edit all of it. |
| Logic never depends on user-defined ids | A status has an id the user picks (`doing`) and a fixed `category` (`inbox`, `todo`, `active`, `later`, `done`). Code only looks at categories, so renaming or reshaping statuses cannot break behaviour. |
| Hebrew-first, RTL | The interface language is Hebrew and the layout is right-to-left. CSS uses logical properties (`margin-inline-start`, `inset-inline-end`). Text direction is decided per string (any Hebrew means RTL). Dates, the work week and the time zone are configurable. |
| Apple HIG look and feel | System-style tab bar and sheets, spring-based motion that can be interrupted, light and dark themes. The reference is `public/design-system.html`. |
| Trust in agents = transparency + undo | Every change is attributed to an actor (`dashboard`, an agent's name, a service name) and stored with the previous values, so it can be undone. |
| Small blast radius | The container is read-only, loopback-bound and has no capabilities. See [security.md](security.md). |

## Components

```text
  Browser / installed PWA                 AI agent (MCP client)          Agent's webhook receiver
  public/*  (vanilla ES modules)          POST /mcp + Bearer token       (delivers to WhatsApp etc.)
     |  ^                                        |                                ^
     |  | SSE  GET /api/events                   |                                | HMAC-signed POST
     v  |      (cookie session)                  v                                |
  +-----------------------------------------------------------------------------+------+
  | server/app.js   host allowlist, CSRF guard, auth, routes, static files, SSE hub     |
  |                                                                                     |
  |   auth.js      pairing codes, device sessions, bearer tokens                        |
  |   access.js    people + spaces; a scoped view of every store per caller             |
  |   agent.js     MCP tools (JSON-RPC 2.0)                                             |
  |                                                                                     |
  |   task-store.js   tasks, activity log, undo, trash  --+                             |
  |   schema.js       board.json + revisions              |  one shared async lock      |
  |   events.js       schedule (events.json)              |                             |
  |   shopping.js     shopping lists (shopping.json)    --+                             |
  |                                                                                     |
  |   scheduler.js  reminders, heads-ups, digest  --->  notifier.js  ------------------>+
  +------------------------------------------+------------------------------------------+
                                             |
                                             v
          data/   tasks/*.md   trash/*.md   board.json   people.json
                  events.json  shopping.json   runtime/*
```

### Server modules (`server/`)

| Module | Responsibility |
|---|---|
| `index.js` | Reads `HOST`/`PORT`, creates the app, starts the scheduler, shuts down cleanly on SIGTERM/SIGINT. |
| `app.js` | HTTP server and router. Host allowlist, CSRF guard, `/api/*` routes, `/mcp`, SSE hub with per-person filtering, static files, `buildVersion()` (hash of `public/`). |
| `auth.js` | Pairing codes (6 digits, hashed, 10 minutes, 5 attempts), device sessions in `runtime/sessions.json`, agent and service bearer tokens. Every credential resolves to `{ actor, kind, user }`. |
| `access.js` | Loads and validates `people.json`. Builds a *scope* per caller and wraps the task and schedule stores so invisible items behave as if they do not exist. Decides reminder recipients. |
| `task-store.js` | Task CRUD, validation against the live schema, reminders, activity log, undo, trash, the compare-and-set bookkeeping used by the scheduler. |
| `repository.js` | Task Markdown file format: parse (tolerant) and serialize (canonical). |
| `schema.js` | `board.json`: validation, defaults, revision counter, last-good copy, degraded mode. |
| `events.js` | The schedule: meetings and blocked time, each optionally linked to a task, with a lead-time reminder. |
| `shopping.js` | Shopping lists with store departments, learned department words, recent items, wish claims. |
| `scheduler.js` | In-process loop (every 20 s): due reminders, schedule heads-ups, morning digest, retries and backoff. |
| `notifier.js` | Signed webhook delivery, one notifier per person. |
| `agent.js` | The MCP tool set (`board`, `find_tasks`, `create_tasks`, `update_tasks`, `remind`, `focus`, `projects`, `calendar`, `add_events`, `update_events`, `shopping`, `history`, `undo`). Resolves natural dates and fuzzy status/project names, answers in short text lines. |
| `summary.js`, `dates.js`, `time.js`, `locale.js` | "What is on my plate" logic, date parsing, time-zone arithmetic, work week and work hours. |
| `fs-util.js` | `writeAtomic`, `appendLine`, `readLines`, `createLock`. |

### Client modules (`public/`)

| File | Responsibility |
|---|---|
| `index.html`, `manifest.webmanifest`, `css/app.css` | App shell, install metadata, all styling (CSS custom properties, logical properties). |
| `sw.js` | Service worker: network-first shell cache, offline snapshot fallback for `/api/bootstrap`. |
| `js/app.js` | Boot, routing, tab bar, context chip, pairing screen, SSE handling, version check, offline snapshot writer. |
| `js/store.js` | Client state, optimistic overlay of pending edits over server-confirmed tasks, contexts, "mine to do", grammatical-gender helper. |
| `js/api.js` | `fetch` wrapper, SSE connection, read-only switch for offline mode. |
| `js/actions.js` | Mutations with optimistic update, rollback, toasts, undo. |
| `js/views.js`, `js/components.js`, `js/drawer.js` | Screens (Today, Inbox, Board, Upcoming, Projects), task rows and cards, the task drawer. |
| `js/schedule.js`, `js/shopping.js`, `js/timeline.js` | Schedule, shopping lists, project timeline (Gantt). |
| `js/settings.js` | Structure and settings editor (writes `board.json` through the API), connected devices. |
| `js/focus.js` | "What should I work on?" ranking. Shared with the server (`agent.js` imports it) so a person and their agent get the same answer. |
| `js/motion.js`, `js/util.js` | Spring physics and gestures; DOM helpers, date helpers, text direction. |

## Data model

Everything is under the data directory (`./data` by default; `/app/data` in the container).

```text
data/
  tasks/<id>.md            one file per task (ids are positive integers, never reused)
  trash/<id>.md            deleted tasks (recoverable; undo restores from the activity log)
  board.json               structure: statuses, priorities, projects, fields, views, notifications
  board.last-good.json     last structure that validated
  people.json              optional: people and spaces (absent = single user)
  events.json              the schedule
  shopping.json            shopping items, recent items, learned departments
  runtime/                 operational state; safe to delete (you lose history and paired devices)
    activity.jsonl         append-only change log (rotates to .1 at 2 MB)
    sessions.json          paired devices (SHA-256 of the cookie token, never the token)
    notifications.jsonl    delivery log (rotates to .1 at 1 MB)
    scheduler.json         last digest sent / digest retry time, per person
```

### A task file

Every front-matter value is JSON, which is also valid YAML. Parsing is tolerant (unquoted values and English `Steps`/`Notes` headings are accepted), so hand edits keep working. Serialization is canonical. The section headings are always written in Hebrew (`שלבים` = steps, `הערות` = notes).

```markdown
---
space: "home"
assignee: "sam"
status: "next"
priority: "high"
project: "kitchen"
tags: ["renovation"]
when: "2026-11-02"
deadline: "2026-11-15"
reminders: [{"id":"r4kx9a","at":"2026-11-14T07:00:00.000Z","anchor":"2026-11-14T09:00","note":"call the tiler","repeat":null,"nag":null,"sent_count":0,"last_sent_at":null,"last_error":null,"retry_at":null,"attempts":0,"done":false,"to":"sam","fail_seq":0,"delivery_failed":false}]
fields: {"cost":"1200"}
order: 1761000000000
archived: false
source: "dashboard"
seen: true
created_at: "2026-10-30T18:02:11.000Z"
updated_at: "2026-10-31T07:45:00.000Z"
completed_at: null
version: 3
---

# Choose kitchen tiles

## שלבים
- [x] Measure the wall
- [ ] Get three quotes
- [ ] Order samples

## הערות
Prefer matte. Ask the neighbour who did their bathroom.
```

Notes on the format:

- `space` and `assignee` are written only when set. A task without `space` belongs to the instance's `defaultSpace`.
- `status`, `priority` and `project` are ids from `board.json`. `when` is "work on it from this day", `deadline` is the due date (both `YYYY-MM-DD`).
- `reminder.at` is stored as UTC ISO. `anchor` is the local wall-clock time, so a repeating reminder stays at 09:00 across daylight-saving changes and on the 31st of a month.
- `source` is `dashboard` or `whatsapp` (created by an agent). `seen: false` marks an agent-created task as new in the Inbox until someone opens it.
- A body line that starts with `## ` is escaped as `\## ` so it cannot be read as a new section.
- `version` is incremented on every save.

### Other files

| File | Shape |
|---|---|
| `board.json` | `{ version, title, publicUrl, statuses[], priorities[], defaultPriority, defaultStatus, projects[], tags[], fields[], views[], notifications{}, rev }`. See [configuration.md](configuration.md#boardjson). |
| `people.json` | `{ users[], spaces[], defaultUser, defaultSpace }`. See [configuration.md](configuration.md#peoplejson) and [multi-user.md](multi-user.md). No secrets in it. |
| `events.json` | `{ "items": [ { id, title, date, start, end, kind, remind, task, with, location, notes, owner, space, reminded_at, … } ] }` sorted by date and time. `kind` is `meeting`, `work` or `other`. `remind` is minutes before the start (`-1` = none, `null` = default: 15 for meetings, 10 otherwise). |
| `shopping.json` | `{ items[], recent[], learned{} }`. Items carry `list`, `text`, `qty`, `note`, `dept`, `done`, `by`, `claimed_by`. |
| `activity.jsonl` | One JSON object per line: `{ id, at, actor, action, task, title, space?, summary, before, after }`. `before` holds only the fields that changed, which is what makes a precise undo possible. A delete stores the whole file. |
| `notifications.jsonl` | One line per delivery attempt: `{ at, event_type, to, message, ok, error? }`. |

## Request flow

1. The HTTP server checks the `Host` header against the allowlist (`421` if unknown).
2. For `POST`, `PATCH`, `PUT`, `DELETE`: a request needs `Content-Type: application/json` or an `Authorization` header (`415` otherwise). Browsers cannot send either cross-site without a CORS preflight, which is never granted.
3. `/api/health`, `/api/version`, `/api/auth/*` and static files are open. Everything else under `/api/` and `/mcp` calls `auth.identify(req)`. It returns `{ actor, kind: 'session' | 'token', user }` or `401`.
4. `ctxFor(who)` builds a *scope* for that person (`access.scope(user)`) and wraps the task and schedule stores. The scoped stores have the same API as the real ones, but anything outside the person's spaces is "not found".
5. The handler calls the store. Writes run under the shared lock, update the file, append to the activity log, and call `onChange`.
6. `onChange` broadcasts an event to every live stream whose person may see it.

A bearer token for a *person's agent* is scoped exactly like that person's devices. A *service* token has `user: null` and sees every space.

## Live updates (SSE)

`GET /api/events` keeps a text/event-stream open (a ping every 25 s, `retry: 3000`). The first message is `{type:'hello', version}`. The server then pushes `task`, `delete`, `activity`, `events` (the schedule changed), `shopping`, `schema` and `notification` events as they happen.

- **Per-person filtering.** Each stream remembers its scope. A `task` event is sent only if the person can see that task's space. Activity entries use the same rule as the history screen. A `notification` event goes only to the recipient. A `shopping` event goes only to people who share the home space.
- **Revocation takes effect immediately.** Revoking a device closes its streams. A stream whose session has expired is dropped at the next broadcast.
- **Limits.** At most 20 concurrent streams; a stream with more than 1 MB of unsent data is closed.
- **Resync.** On reconnect (`hello`) the client refetches `/api/bootstrap`, so a missed event is never permanent.

## Reminders and the scheduler

`scheduler.js` runs inside the process (first tick after 3 s, then every 20 s). No cron, no agent scheduling.

| Job | Behaviour |
|---|---|
| Task reminders | A reminder has `at` and optionally `repeat` (`daily`, `weekdays`, `weekly`, `monthly`) or `nag` (re-send every 5 to 1440 minutes until the task is done), never both. Recipients: [multi-user.md](multi-user.md#who-gets-a-reminder). Nags pause during quiet hours; an explicit reminder time is always honoured. Reminders of finished tasks are retired. |
| Schedule heads-ups | A message `remind` minutes before each schedule item. Skipped if the item already started more than 10 minutes ago (server was down). |
| Morning digest | Once per person on the configured days, after the configured time, with what is theirs (their spaces plus shared tasks on them) and their schedule. Not sent if more than 3 hours late. |
| Delivery | `notifier.send` posts JSON to the person's webhook, signed with HMAC-SHA256 (`X-Webhook-Signature`), with an `X-Request-Id`. Timeout 8 s. |
| Retries | Exponential backoff 2, 4, 8 … minutes, capped at one hour. After 8 attempts or 24 hours the reminder is marked `delivery_failed` (shown in red); a repeating reminder moves to its next occurrence. |
| Idempotency | The request id is stable per occurrence (`wb-<task>-<reminder>-<at>-<failures>`). If the process crashed or timed out after the receiver already delivered, the retry reuses the id and a receiver with an idempotency cache drops the duplicate. A definite rejection (non-2xx answer) changes the id. |

Before sending, the scheduler re-reads the task, so a reminder snoozed, completed or deleted while it waited in the queue is never sent from a stale snapshot.

## Agents (MCP)

`POST /mcp` speaks JSON-RPC 2.0 over stateless Streamable HTTP (protocol `2025-06-18`, older versions accepted; `GET` returns `405`). Auth is the same as the API.

- The tools are designed so that a typical chat request is one call. Answers are short text lines, never the whole board as JSON. Dates are resolved server-side in the instance time zone and work week ("tomorrow", "Sunday 09:30", `+90m`). Statuses and projects are matched by id, label or alias. Batch writes report per item.
- The tool descriptions name the agent's own person ("{user}"), so a household with two agents gets two correctly addressed tool lists.
- The same capabilities exist over REST (`/api/tasks`, `/api/schedule`, `/api/schema`, `/api/shopping`, `/api/activity/<id>/undo` …) with `Authorization: Bearer <token>`.
- The actor in the activity log comes from the credential, never from a request header.
- Tool failures come back as text with `isError: true`, so the model can correct itself.

## Concurrency and crash safety

| Mechanism | Detail |
|---|---|
| Single process, single lock | `createLock()` is a promise chain. Tasks, structure, schedule and shopping share one lock, so a status cannot be removed while a task is being moved into it. Run exactly one instance per data directory. |
| Atomic writes | `writeAtomic` writes `<file>.<pid>.<ts>.tmp` and renames it over the target. A crash or a concurrent reader never sees half a file. |
| Append-only logs | Activity and notification logs are appended one JSON line at a time; unparsable lines are skipped on read. |
| Per-task `version` | Incremented by one on every save. Clients keep the highest version they have seen and drop an older response or live event, so a slow reply cannot overwrite newer state. It is not an edit-conflict check: two writers both succeed, and the later one wins field by field. |
| Revision on structure | `board.json` carries `rev`. A writer that sends an older `rev` gets `409 conflict` and must re-read. |
| Compare-and-set bookkeeping | The scheduler records "sent" with an `expect` of what it saw (`at`, `done`, `repeat`, `nag`, `anchor`). If a person snoozed or edited the reminder meanwhile, the bookkeeping is skipped instead of overwriting their change. Schedule items use the same pattern (`date`, `start`, `remind`). |
| Undo conflicts | Undo reverts only the fields an entry changed, and refuses with `409` if one of them changed again since. The revert is itself an entry, so it can be undone (redo). |
| Broken `board.json` | A hand edit that fails validation puts the board in degraded mode: a copy is saved as `board.json.broken-<timestamp>`, the last good structure is served, structure writes are refused (`503`) until the file is fixed or `POST /api/schema/restore` accepts what is served. |

## Offline and PWA

- **Installable.** `manifest.webmanifest` plus icons. On iOS, "Add to Home Screen" gives a full-screen app. The installed app has its own cookie jar, so pair it from inside the app.
- **Service worker.** Network-first for the shell (a deploy is picked up on the next load, the cache is only the fallback). `/api/*` is never cached, except `/api/bootstrap`, which falls back to a snapshot.
- **Offline snapshot.** After every server-confirmed change the page stores the confirmed board (never in-flight edits) in the `workboard-snapshot` cache. Offline, the app opens that snapshot read-only with its age shown; writes are blocked centrally in `api.js`.
- **Build version.** `buildVersion()` hashes every file under `public/`. It is in `/api/version`, `/api/health` and the SSE `hello`. When it differs from the version the page loaded with, the app reloads as it returns from the background, or shows an "update" bar if it is on screen, so a deploy never yanks a page mid-typing.
- **Optimistic UI.** Edits show immediately as an overlay on the confirmed task and roll back with a toast if the server refuses.
