# Security

Workboard holds personal task data and can message people on their behalf. It is built for one person or a household that trusts each other, on a private host, behind TLS. This page states what it defends against, what it does not, and how to deploy it safely. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Threat model

| In scope | Control |
|---|---|
| A stranger who can reach the URL | Nothing except static files, `/api/health`, `/api/version` and the pairing endpoints answers without a credential. Pairing needs a code delivered to the person's own messaging account. |
| Another device on the same network or tailnet | Network membership is not trusted: each browser must be paired. |
| A malicious web page open in a paired browser | Cookie is `SameSite=Strict`; writes need a JSON content type (CSRF guard). |
| DNS rebinding against a board on a private network | Host header allowlist. |
| One person reading another's tasks | Server-side per-person scoping of every read, write and live event. |
| A bad deploy | Fast-forward, required checks green, test-gated, health-checked, auto-rollback. |
| A malicious commit on `main` (a merged PR or a compromised account) | Branch protection with required reviews and checks; commits that touch the deployment machinery (`deploy/`, `compose.yml`, `Dockerfile`, `.github/`) are never deployed automatically; the deploy script runs from a pinned copy outside the checkout; app code only runs inside the hardened container. Residual risk: malicious *app* code would run in that container with access to your data. |
| A compromised app process | Read-only filesystem, no capabilities, no new privileges, loopback-only port, resource limits. |

| Out of scope | Why |
|---|---|
| Someone with shell or disk access to the host | Data is stored as plain files and the pairing code is in the log by design. |
| Hostile household members | Spaces are a convenience boundary. Anyone can change the shared board structure and all shopping lists, and a service token sees everything. |
| Denial of service from the internet | There is only basic throttling on pairing, a cap on live streams and a request-size limit. Do not expose the board publicly. |
| Hosting multiple unrelated tenants in one instance | Not a design goal. Run one instance per household. |

## Authentication

### Device pairing

There are no passwords. A browser pairs once:

1. The person picks who they are (names only are listed) and asks for a code.
2. A 6-digit code is generated with a cryptographically secure RNG, stored only as a SHA-256 hash in memory, and sent to **that person's** webhook (for example as a WhatsApp message through their agent).
3. Entering the code creates a device session: a random 256-bit token. The server keeps only its SHA-256 hash in `runtime/sessions.json`. The browser gets it as a cookie.

| Property | Value |
|---|---|
| Code lifetime | 10 minutes, one active code per person |
| Wrong guesses | 5 attempts, then the code is void |
| Requests | 1 per minute per person, 5 per hour overall (HTTP 429) |
| Session lifetime | 400 days, the longest a browser keeps a cookie |
| Revocation | Immediate. Settings lists your devices; revoking one deletes its session and closes its live streams. |
| Constant-time comparison | Used for codes and tokens |

Pending codes live in memory, so a restart voids them. The code is also logged (`[auth] pairing code …`) as a fallback when messaging is down, so protect access to the logs.

### Cookies

`wb_session` is `HttpOnly` (not readable by scripts), `SameSite=Strict` (never sent on cross-site requests), `Path=/`, and `Secure` when the request came over HTTPS (`X-Forwarded-Proto: https`) or from a `.ts.net` host. Make sure your proxy sets `X-Forwarded-Proto`.

### Token types

| Token | Configured by | Acts as | Sees |
|---|---|---|---|
| Device session (cookie) | pairing | `dashboard` or `dashboard-<person>` | that person's spaces |
| Person's agent token | `WORKBOARD_AGENT_TOKEN`, `WORKBOARD_AGENT_TOKENS` | the configured actor name | that person's spaces |
| Service token | `WORKBOARD_SERVICE_TOKENS` | the configured actor name | everything |

- Tokens are compared in constant time after hashing. Generate each with `openssl rand -hex 32` and use a different one per agent.
- The actor in the activity log comes from the credential, never from a header, so an agent cannot impersonate a person's devices. Names beginning with `dashboard` are refused for tokens.
- A bearer-token request is also exempt from the JSON-content-type rule, because a bearer header cannot be forged cross-site.
- Only a paired dashboard device can revoke devices; a token cannot.
- Treat a service token like a root key: it bypasses per-person scoping. Use it only for tools you run yourself.

## Request hardening

| Control | Detail |
|---|---|
| Host allowlist (DNS rebinding) | Requests whose `Host` is not in `WORKBOARD_HOSTS` (plus `localhost`, `127.0.0.1`, `[::1]`) get `421`. A malicious site that rebinds its DNS name to your private address cannot read the board. |
| CSRF guard | `POST`, `PATCH`, `PUT`, `DELETE` without `Content-Type: application/json` (or an `Authorization` header) get `415`. A cross-site form or `fetch` cannot send JSON without a CORS preflight, and the server never grants one (no CORS headers at all). |
| Body limit | 512 KB per request. |
| Live streams | At most 20 concurrent; slow consumers are dropped. |
| Static files | Path is resolved and must stay inside `public/`; responses carry `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. API responses are `Cache-Control: no-store`. |
| Test message | `/api/notifications/test` sends a fixed text, once a minute: it can never become a way to send arbitrary messages. |
| Scoping | Done in the server for every route, the MCP tools and the live stream; a hidden task answers `404`, same as a missing one. |

The server does not set a Content-Security-Policy or `X-Frame-Options`. If you want them, add them at the proxy (for example `frame-ancestors 'none'` and HSTS). The client builds the DOM through a small element helper and sets text as text; the helper's raw-HTML option is not used anywhere, so task text is never parsed as markup.

## Webhooks and delivery

- Outgoing messages are signed: `X-Webhook-Signature` is the hex HMAC-SHA256 of the raw body with the shared secret. Verify it, in constant time, in your receiver.
- `X-Request-Id` is stable per occurrence, so a receiver with an idempotency cache turns a retry after a timeout into a no-op instead of a double message.
- Timeout 8 seconds; exponential backoff on failure; a reminder gives up after 8 attempts or 24 hours and is flagged in the interface.
- Webhook URLs should be internal (a container network or loopback), not public.

## Container hardening

`compose.yml` runs the app as the unprivileged `node` user with:

| Setting | Effect |
|---|---|
| `read_only: true` + `tmpfs: /tmp` | The image cannot be modified at run time; only `/app/data` (a mounted volume) is writable. |
| `cap_drop: [ALL]` | No Linux capabilities. |
| `security_opt: no-new-privileges` | No privilege escalation through setuid binaries. |
| `ports: 127.0.0.1:3000:3000` | Reachable only from the host itself; a reverse proxy is the front door. |
| `mem_limit: 128m`, `cpus: 0.25` | Contains a runaway process. |
| Healthcheck | Restarts on repeated failure. |

The image installs nothing at run time and has no runtime dependencies to patch beyond Node itself. Rebuild periodically (the update pipeline does, on each deploy) to pick up base-image fixes.

## What not to expose

- Do not publish the container port: keep `WORKBOARD_BIND=127.0.0.1`.
- Do not put the board on the open internet (including Tailscale Funnel) unless you accept that the pairing endpoints are reachable by anyone. The code protects data, not availability.
- Do not expose `/mcp` or `/api/*` through a second, unauthenticated proxy path.
- Never share `.env`, `data/` or `runtime/sessions.json`.
- Do not run with `WORKBOARD_DEV_NO_AUTH=1` anywhere but a local loopback test (the server refuses it on non-loopback hosts, which includes the container).
- `/api/health` and `/api/version` are open and reveal the build version and whether a token and webhook are configured. Restrict them at the proxy if that matters to you.

## Data at rest

Everything is a plain file: tasks as Markdown, structure and schedule as JSON, history as JSON lines. Nothing is encrypted by the application, and that is deliberate (inspectable, diffable, easy to back up). Protect the host: full-disk encryption, restricted permissions on the instance directory (the app itself needs write access for uid 1000 only), and encrypted off-site backups. Secrets live in `.env`, never in `data/`. `runtime/sessions.json` contains only token hashes, but it should still be kept private. Deleted tasks stay in `trash/` and in the activity log until you remove them.

## Public-repository deploy model

The project is public and your server follows it. The pipeline keeps that safe:

- Your deploy checkout fetches over anonymous HTTPS and holds **no write credential**. A compromised server cannot push code.
- Only commits that are a **fast-forward** of what runs, sit on the protected `main` branch, and have **green CI** for that exact commit are deployed. Protect `main` on GitHub: require pull requests and status checks, disallow force pushes.
- Changes to the deployment machinery (`deploy/`, `compose.yml`, `Dockerfile`, `.dockerignore`, `.github/`) wait for a human (`FORCE=1` after review), and the deploy script runs from a pinned copy outside the checkout — a commit can't rewrite the rules it is judged by.
- The required checks are named: a commit can't pass by removing its own CI jobs.
- Tests run again on the host, in a container with no network, before anything is built.
- The new container must report healthy, or the previous image is restored.
- Nothing personal is in the repository: configuration, secrets and data live in your instance directory, outside the code.

If you fork, you take over the trust decision: you decide who can merge to the branch your server follows. Review upstream changes before you merge them.

## Reporting

Please report vulnerabilities privately, following [SECURITY.md](../SECURITY.md).
