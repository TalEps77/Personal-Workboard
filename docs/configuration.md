# Configuration

Workboard is configured in three places, all outside the code:

| Where | What | Who edits it |
|---|---|---|
| Environment (`.env` in your instance directory) | Network, time zone and work week, secrets (tokens, webhook secrets) | You, then restart the container |
| `data/people.json` | People and spaces | You, then restart |
| `data/board.json` | Board structure: statuses, priorities, projects, fields, views, notification rules | The Settings screen, or an agent over MCP/REST. Hand edits work too |

Secrets belong only in the environment. `people.json` and `board.json` hold no secrets.

A template with every variable is in `examples/.env.example`. Generate secrets with `openssl rand -hex 32`. Environment variables are read once at start-up.

## Environment variables

### Network and runtime

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` (the container sets `0.0.0.0`) | Address the Node server binds to. |
| `PORT` | `4173` (the container sets `3000`) | Port the Node server listens on. |
| `WORKBOARD_HOSTS` | `workboard:3000,workboard` | Comma-separated `Host` header values the server answers to (DNS-rebinding guard). `localhost`, `127.0.0.1` and `[::1]` (any port) are always allowed. **Include the public name you reach the board by**, e.g. `board.example.com`, or every request gets `421 unknown_host`. |
| `PUBLIC_URL` | empty | Base URL used for links inside delivered messages (reminders, digest). Alias: `WORKBOARD_PUBLIC_URL`. It is only the initial value of `publicUrl` in `board.json`; afterwards change it in Settings. |
| `WORKBOARD_INSTANCE` | unset | If set, `/api/health` echoes it as `instance`. Used by the browser test runner to be sure it is talking to its own server. |
| `WORKBOARD_DEV_NO_AUTH` | unset | `1` skips pairing and trusts `X-User` / `X-Actor` headers. Honoured only when `HOST` is `127.0.0.1`, `localhost` or `::1`. Development only. |

### Calendar and locale

| Variable | Default | Meaning |
|---|---|---|
| `TZ` | `Asia/Jerusalem` | Time zone for "today", reminders, the schedule and the digest. Any IANA name. |
| `WORKBOARD_TZ` | unset | Same, takes precedence over `TZ`. |
| `WORKBOARD_WORKWEEK` | `sun-thu` | Work days. `sun-thu`, `mon-fri`, `mon-sat` (any `ddd-ddd` range with `sun mon tue wed thu fri sat`), or a list of numbers where 0 is Sunday: `0,1,2,3,4`. "Next week" means the first work day of next week, "end of week" its last work day. An invalid value stops the server at start-up. |
| `WORKBOARD_WORK_HOURS` | `08:00-17:00` | When the "automatic" context means work (see [multi-user.md](multi-user.md#contexts-in-the-ui)). Format `HH:MM-HH:MM`. |
| `WORKBOARD_OWNER_NAME` | `אני` ("me") | Display name of the single person when there is no `people.json`. |

### Credentials for agents and tools

All are optional. Without any of them no agent can call the API; the dashboard still works through paired devices.

| Variable | Alias (older name) | Format | Meaning |
|---|---|---|---|
| `WORKBOARD_AGENT_TOKEN` | `HERMES_API_TOKEN` | one secret | Bearer token for the **default person's** agent. Its actor name in the activity log is that person's `agentActor` from `people.json`, or `agent`. Single-user setups only need this. |
| `WORKBOARD_AGENT_TOKENS` | `WORKBOARD_AGENTS` | `person:actor:token,person:actor:token` | One token per person's agent. `person` must be a user id in `people.json` (unknown ids are silently ignored). `actor` is the name shown in the activity log. The token may contain `:` but not `,`. |
| `WORKBOARD_SERVICE_TOKENS` | `WORKBOARD_EXTRA_TOKENS` | `actor:token,actor:token` | Maintenance tokens that see **every** space (scope "all"). For tools you run yourself, not for a person's agent. |

Actor names are lowercased and reduced to `a-z 0-9 _ -`. Names starting with `dashboard` are rejected (reserved for paired browsers). A new-style variable wins over its alias if both are set.

### Delivery (reminders, digest, pairing codes)

Workboard does not talk to WhatsApp itself. It posts a JSON message to a webhook you run (the project is built around an agent such as Hermes with a "deliver only" webhook route, but any receiver that verifies the signature works). Without a webhook the board still works; reminders are recorded as failed and pairing codes appear only in the server log.

| Variable | Alias (older name) | Format | Meaning |
|---|---|---|---|
| `WORKBOARD_WEBHOOK_URL` | `HERMES_WEBHOOK_URL` | URL | Webhook of the **default person**, e.g. `http://agent:8644/webhooks/workboard`. |
| `WORKBOARD_WEBHOOK_SECRET` | `HERMES_WEBHOOK_SECRET` | secret | HMAC-SHA256 key for that webhook. |
| `WORKBOARD_WEBHOOKS` | none | `person\|url\|secret,person\|url\|secret` | Webhooks of the other people. Secrets and URLs must not contain `\|` or `,`. |

The request body is `{ "event_type": "workboard.reminder", "message": "…", … }`, with headers `X-Webhook-Signature` (hex HMAC-SHA256 of the raw body) and `X-Request-Id` (stable per occurrence, so a retry can be de-duplicated). Event types: `workboard.reminder`, `workboard.event`, `workboard.digest`, `workboard.pairing`, `workboard.test`.

### Compose variables

Read by `compose.yml` from the file you pass with `--env-file`. They are not seen by the app.

| Variable | Default | Meaning |
|---|---|---|
| `WORKBOARD_PORT` | `3000` | Host port. |
| `WORKBOARD_BIND` | `127.0.0.1` | Host address the port is published on. Keep loopback and put a TLS proxy in front. |
| `WORKBOARD_DATA_DIR` | `./data` | Host directory mounted at `/app/data`. Use an **absolute path** in an instance directory. It must be writable by uid 1000 (`node`). |
| `WORKBOARD_ENV_FILE` | `.env` | Path of the env file passed into the container. **Set this to the absolute path of your instance `.env`**; with the default, the container looks for `.env` next to `compose.yml` and silently starts without your settings if there is none. |
| `WORKBOARD_CONTAINER` | `workboard` | Container name. |
| `WORKBOARD_IMAGE` | `workboard:local` | Image tag. `deploy/update.sh` sets `workboard:<commit>` so it can roll back. |
| `TZ` | `Asia/Jerusalem` | Passed to the container. |

The compose file also fixes `mem_limit: 128m` and `cpus: 0.25`. Change them in a `compose.override.yml` if your data grows. See `examples/compose.override.yml` for joining an agent's Docker network.

## `people.json`

Optional. Without it the board is single-user: one person (`me`) with one `work` space. Details of the model are in [multi-user.md](multi-user.md). The file is validated at start-up; a mistake stops the server with a message naming the problem.

```json
{
  "users": [
    { "id": "alex", "name": "Alex", "gender": "m", "agent": "Hermes", "agentActor": "hermes" },
    { "id": "sam",  "name": "Sam",  "gender": "f", "agent": "Nova",   "agentActor": "nova" }
  ],
  "spaces": [
    { "id": "work",      "label": "Work",     "owner": "alex", "kind": "work" },
    { "id": "alex-life", "label": "Personal", "owner": "alex", "kind": "personal" },
    { "id": "home",      "label": "Home",     "kind": "home", "members": ["alex", "sam"] },
    { "id": "sam-work",  "label": "Work",     "owner": "sam",  "kind": "work" },
    { "id": "sam-life",  "label": "Personal", "owner": "sam",  "kind": "personal" }
  ],
  "defaultUser": "alex",
  "defaultSpace": "work"
}
```

### `users[]`

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Lowercase letters, digits, `-`, `_`; 1 to 32 characters; starts with a letter or digit; unique. Appears in task files (`assignee`), tokens and webhook settings. Do not rename it later without rewriting data. |
| `name` | no | Display name in the interface. |
| `gender` | no | `m` (default) or `f`. The interface addresses the person in that grammatical gender (Hebrew). |
| `agent` | no | Display name of this person's agent ("Hermes", "Nova"), used in interface copy. |
| `agentActor` | no | Actor name that agent's token writes into the activity log. For the default user it is also the actor of `WORKBOARD_AGENT_TOKEN`. |

### `spaces[]`

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Same rules as user ids. Stored in each task as `space`. |
| `label` | no | Name in the interface. Other people's spaces are shown as `label · owner name`. |
| `kind` | yes | `work`, `personal` or `home`. Drives colour, tabs, which shopping lists open and the automatic context. |
| `owner` | one of `owner` / `members` | A user id. A space with an owner is private to that person. |
| `members` | one of `owner` / `members` | User ids. A space with no owner is shared by its members (the household's `home`). If both are given the owner and the members all see it. |

### Top level

| Field | Default | Meaning |
|---|---|---|
| `defaultUser` | `me` | The board's primary person. Tasks, schedule items, devices and activity from before there were several people belong to this user. Only this person sees and may undo structure changes. Their agent is reached through `WORKBOARD_AGENT_TOKEN` and `WORKBOARD_WEBHOOK_*`. Must be a user id. |
| `defaultSpace` | `work` | Where a task with no `space` lives. Must be a space id. |

The older names `legacyUser` and `legacySpace` are still accepted when the new ones are absent.

## `board.json`

Created with defaults on first start. Every successful write increments `rev`. Edit it from Settings or over the API while the server runs. A hand edit is picked up only at the next start (the server caches the structure), so stop the server first or restart afterwards. Statuses and projects still used by a task cannot be removed. Archive the project instead, or move the tasks first. If the file becomes invalid the server serves the last good copy and refuses structure writes until you fix it ([architecture.md](architecture.md#concurrency-and-crash-safety)).

Over REST: `GET /api/schema`, `PATCH /api/schema` (shallow merge of top-level keys, for example `{"projects": [...]}`) and `PUT /api/schema` (replace). Send the `rev` you read; an older `rev` gets `409`. People who are not the default user can edit the shared structure; they only see the projects of their own spaces.

| Key | Meaning |
|---|---|
| `title` | Board name. |
| `publicUrl` | Base URL for links in delivered messages. |
| `statuses[]` | `{ id, label, category, color }`. `category` is one of `inbox`, `todo`, `active`, `later`, `done`. At least one `inbox` and one `done` status are required. Logic uses categories only. |
| `defaultStatus` | Status of a new task when none is given. Default `next`. |
| `priorities[]` | `{ id, label, color, rank }`. Lower `rank` sorts first. |
| `defaultPriority` | Default `normal`. |
| `projects[]` | `{ id, name, color, archived, goal, due, aliases[], milestones[], space }`. `goal` is up to 300 characters. `due` is `YYYY-MM-DD`. `aliases` are extra names an agent may use. `milestones` are `{ id, title, date, done }`. `space` is the space the project belongs to; omitted means the default space. People only see and edit projects of their own spaces. |
| `tags[]` | Known tags (tasks can carry any tag). |
| `fields[]` | Custom task fields: `{ id, label, type, options?, projects?, showOnCard }`. `type` is `text`, `number`, `date`, `select` (needs `options`), `url` (must be http or https), `duration`, `checkbox`. `projects` limits the field to those projects. Values live in a task's `fields`. |
| `views[]` | Saved views: `{ id, name, icon, filter, sort, group, layout }`. `filter` keys: `status`, `category`, `project`, `priority`, `tags`, `due`, `text`, `source`, `hasReminder`. `sort`: `manual`, `priority`, `deadline`, `when`, `updated`, `created`, `title`. `group`: `none`, `status`, `project`, `priority`, `when`. `layout`: `list` or `board`. |
| `notifications` | See below. |
| `rev` | Revision counter, managed by the server. |

Ids in `board.json` are lowercase `a-z 0-9 - _`, up to 40 characters, and unique within their list. Colours: `gray accent blue teal green amber orange red pink purple`.

### Notifications

| Key | Default | Meaning |
|---|---|---|
| `notifications.enabled` | `true` | Master switch for the scheduler. Off means no reminders, heads-ups or digest. |
| `notifications.channel` | `whatsapp` | Label only. |
| `notifications.quietHours` | `{ "start": "22:00", "end": "07:30" }` | Nags (repeat-until-done reminders) pause in this window and resume when it ends. Reminders with an explicit time always fire. The window may cross midnight. |
| `notifications.digest` | `{ "enabled": false, "time": "08:30", "days": [0,1,2,3,4] }` | Morning summary, one per person with what is theirs. `days` are 0 (Sunday) to 6 (Saturday), in the instance time zone. |
