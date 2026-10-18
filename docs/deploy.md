# Self-hosting

Workboard runs as one small container (or a plain `node` process) behind a TLS reverse proxy. Code and instance are kept apart: the **code** is a checkout of this repository, the **instance** is a directory you own holding `.env`, optional overrides, and `data/`.

## Quick start (Docker)

Requirements: Docker with the compose plugin, `git`.

```sh
# 1. Code
git clone https://github.com/TalEps77/Personal-Workboard.git ~/personal-workboard

# 2. Instance directory (outside the repository)
mkdir -p ~/workboard-instance/data
cp ~/personal-workboard/examples/.env.example ~/workboard-instance/.env
cp ~/personal-workboard/examples/people.json ~/workboard-instance/data/people.json   # optional, see multi-user.md
sudo chown -R 1000:1000 ~/workboard-instance/data     # the container runs as uid 1000 (node)

# 3. Edit ~/workboard-instance/.env (see below), then start
cd ~/personal-workboard
docker compose --env-file ~/workboard-instance/.env up -d --build
curl -s http://127.0.0.1:3000/api/health
```

Edit these in `.env` first (all variables: [configuration.md](configuration.md)):

```sh
WORKBOARD_DATA_DIR=/home/you/workboard-instance/data     # absolute path
WORKBOARD_ENV_FILE=/home/you/workboard-instance/.env     # absolute path, this very file
WORKBOARD_HOSTS=board.example.com,workboard:3000,workboard
PUBLIC_URL=https://board.example.com
TZ=Europe/Berlin
WORKBOARD_WORKWEEK=mon-fri
```

Two things trip people up:

- `WORKBOARD_ENV_FILE` must point at your `.env`. `--env-file` only feeds compose's own variable substitution; the app's settings reach the container through `env_file`, whose default is `.env` next to `compose.yml`. If that file is missing compose does not complain and the app starts with defaults.
- `WORKBOARD_HOSTS` must contain the host name you open in the browser, otherwise every request is answered with `421 unknown_host`.

The container publishes `127.0.0.1:3000` only. Do not change `WORKBOARD_BIND` to a public address; use a reverse proxy.

The compose file runs the container read-only with all capabilities dropped, limits it to 128 MB and a quarter of a CPU, and health-checks `/api/health`.

### Agents and message delivery

Reminders, the digest and pairing codes are delivered by posting to a webhook (see [configuration.md](configuration.md#delivery-reminders-digest-pairing-codes)). An agent that should call Workboard over MCP needs network access to `http://workboard:3000/mcp` and an agent token. If your agent runs in another Docker network, join it with a `compose.override.yml` kept in the instance directory (`examples/compose.override.yml`):

```sh
docker compose -f compose.yml -f ~/workboard-instance/compose.override.yml --env-file ~/workboard-instance/.env up -d
```

Workboard works without any agent: tasks, schedule, shopping and the dashboard need none. Without a webhook, reminders are not delivered and the pairing code is printed in the server log (see next section).

## Reverse proxy and TLS

The app speaks plain HTTP on loopback. Terminate TLS in front of it. Requirements, whatever you use:

- Forward the original `Host` (it must be in `WORKBOARD_HOSTS`).
- Send `X-Forwarded-Proto: https`. The server marks the session cookie `Secure` when it sees that header (or a `.ts.net` host).
- Do not buffer `GET /api/events` (live updates, server-sent events). The server sends `X-Accel-Buffering: no`, which nginx honours.

### Caddy

```caddyfile
board.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

Caddy obtains certificates and sets `X-Forwarded-Proto` and the `Host` header for you.

### Tailscale

For a board reachable only from your own devices:

```sh
tailscale serve --bg 3000          # https://<machine>.<tailnet>.ts.net  ->  127.0.0.1:3000
```

Add that `.ts.net` name to `WORKBOARD_HOSTS` and `PUBLIC_URL`. Use `serve`, not `funnel` (funnel publishes to the internet). Everyone on a tailnet under one login can reach the board, so pairing still matters.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name board.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
        proxy_read_timeout 1h;       # the live stream stays open
    }
}
```

## Pair the first device

Browsers need a one-time pairing; there is no password.

1. Open `https://board.example.com`. The pairing screen appears. With several people, tap your name.
2. Request a code. The 6-digit code is sent to your webhook (typically as a WhatsApp message) and is valid for 10 minutes, five attempts.
3. Type it in. The device is paired for up to 400 days.

No webhook configured yet? The code is also written to the server log:

```sh
docker logs workboard 2>&1 | grep 'pairing code'
```

That is the bootstrap path for the very first device. Anyone with access to the host can read it, which is the intended trust boundary.

On iOS, install to the Home Screen first (Share, Add to Home Screen) and pair from inside the installed app: it has its own cookie jar, separate from Safari. Devices are listed and revoked under Settings, Connected devices.

## Safe update pipeline

`deploy/update.sh` pulls and deploys new commits from GitHub unattended. It is designed for a **public repository** and a **deploy-only checkout**: fetching is anonymous HTTPS and the checkout never needs a write credential.

It deploys a new commit only when **all** of these hold:

| Check | Detail |
|---|---|
| Fast-forward | The commit on `origin/main` descends from what is running. A rewritten branch is never deployed automatically; a warning is logged. |
| Required checks are green | The checks named in `REQUIRED_CHECKS` (default `Unit tests` and `Browser tests (Chromium)`) all exist for that exact commit and concluded `success`. A commit cannot pass by deleting its own CI jobs: a missing required check blocks it. Pending means "wait". Disable with `REQUIRE_CI=0` if your fork has no CI. |
| Deployment machinery unchanged | A commit that touches `deploy/`, `compose.yml`, `Dockerfile`, `.dockerignore` or `.github/` is **not** deployed automatically: review the diff, update your pinned `update.sh` if it changed, then run once with `FORCE=1`. |
| Tests pass here | `node --test` runs again on that checkout in a throwaway container (`--network none`, source mounted read-only). |
| Healthy after start | The new image is built as `workboard:<commit>` and started. If `/api/health` does not answer within about a minute, the previous image is started again (`rolled back`). |

Host requirements: `docker` (with compose), `git`, `curl`, `node` (used to parse the GitHub reply), `flock`, `timeout`. The user running it must be able to use Docker.

Configuration is by environment:

| Variable | Default | Meaning |
|---|---|---|
| `INSTANCE_DIR` | required | Holds `.env`, `data/`, optional `compose.override.yml`. Logs and state go here too. |
| `REPO_DIR` | the checkout containing the script | The deploy checkout. |
| `BRANCH` | `main` | Branch to follow. |
| `GITHUB_REPO` | parsed from the `origin` URL | `owner/name` used for the CI check. |
| `REQUIRE_CI` | `1` | `0` skips the CI check. |
| `REQUIRED_CHECKS` | `Unit tests,Browser tests (Chromium)` | Check names that must all be present and green. |
| `MANUAL_PATHS` | `deploy/ compose.yml Dockerfile .dockerignore .github/` | Changes here wait for `FORCE=1`. |
| `FORCE` | `0` | `1` deploys a reviewed commit that touches `MANUAL_PATHS`. |
| `NODE_IMAGE` | `node:22-alpine` | Image used for the test run. |
| `KEEP_IMAGES` | `3` | Old images kept for rollback. |

You may also pass a file as the first argument; it is sourced and may set the variables above.

State in `INSTANCE_DIR`: `deploy.log` (what happened), `last-deployed` (full SHA of what is running), `.failed-sha` (a commit that failed tests or health is not retried until `FORCE=1`), `.deploy.lock` (a second run exits at once), `.warn-*` (so a stuck state logs its warning at most once an hour).

**Run a pinned copy.** The script decides whether new code is trustworthy, so it must not come from that new code. Install it once and refresh it by hand when you review a change to it:

```sh
install -D ~/personal-workboard/deploy/update.sh ~/workboard-instance/bin/update.sh
```

### Install: cron

```cron
*/5 * * * * INSTANCE_DIR=/home/you/workboard-instance REPO_DIR=/home/you/personal-workboard /home/you/workboard-instance/bin/update.sh
```

### Install: systemd timer

```sh
mkdir -p ~/.config/systemd/user
cp ~/personal-workboard/deploy/workboard-update.{service,timer} ~/.config/systemd/user/
# edit Environment=INSTANCE_DIR / REPO_DIR and the ExecStart path (the pinned copy) if your paths differ
systemctl --user daemon-reload
systemctl --user enable --now workboard-update.timer
loginctl enable-linger "$USER"        # keep user timers running when you are logged out
```

The timer fires two minutes after boot and every five minutes afterwards. Check it with `systemctl --user list-timers` and `journalctl --user -u workboard-update`.

### First run, logs, rollback

- On the first run there is no `last-deployed`, so the current `origin/main` is deployed (after CI and tests). To record a manual deployment so the script does not redeploy it, write the full SHA into `INSTANCE_DIR/last-deployed`.
- Read the log: `tail -f ~/workboard-instance/deploy.log`.
- **Automatic rollback** happens only for a failed start. A deploy that starts healthy but misbehaves is yours to roll back.
- **Manual rollback, the safe way:** `git revert` the bad commit on `main` and push. It is a fast-forward, goes through CI and is deployed like anything else.
- **Manual rollback, immediate:** pause the timer or cron line, then
  ```sh
  cd ~/personal-workboard && git checkout --detach <good-sha>
  WORKBOARD_IMAGE=workboard:<first-12-chars> docker compose -p workboard \
    -f compose.yml -f ~/workboard-instance/compose.override.yml \
    --env-file ~/workboard-instance/.env up -d --no-build
  echo <full-good-sha> > ~/workboard-instance/last-deployed
  ```
  Leave out the override `-f` if you have none. Old images are kept (`docker images workboard`); one that was pruned can be rebuilt by dropping `--no-build`. Resume the timer only after `main` has a fix: otherwise it moves forward to the bad commit again.
- **Manual deploy** of the checked-out code without the pipeline: `docker compose --env-file ~/workboard-instance/.env up -d --build`.

Data is never touched by a deploy: it lives in `data/`, outside the image. The browser picks up a new build by itself (see [architecture.md](architecture.md#offline-and-pwa)).

## Backups

All state is in the data directory, and all of it is plain files.

- **Copy it.** Stop nothing; writes are atomic, so a copy of `data/` at any moment is consistent per file. `rsync -a ~/workboard-instance/data/ backup:/path/` or a snapshot of the volume is enough. Include `people.json`, `board.json`, `tasks/`, `events.json`, `shopping.json`. `runtime/` holds paired devices and the activity log: copy it too if you want undo history and devices to survive a restore; if you lose it, people just pair again.
- **Local history with git.** `deploy/snapshot.sh` keeps a local git history of the data, so any change can be inspected or rolled back. Run it hourly:
  ```cron
  0 * * * * DATA_DIR=/home/you/workboard-instance/data /home/you/personal-workboard/deploy/snapshot.sh
  ```
  It creates the repository on first run, commits only when something changed, and excludes `runtime/` and `trash/`. The history contains your tasks. Keep it private and never add a remote. Snapshots complement, not replace, an off-machine copy.
- **Restore** by copying files back while the container is stopped, then starting it.

## Upgrading notes

- Files are forward compatible: the parser accepts older task files and `people.json` keys (`legacyUser`, `legacySpace`), and old variable names keep working (see the aliases in [configuration.md](configuration.md)).
- Read the commit log before large jumps. Structure changes only ever go through validation, and a bad `board.json` puts the board in a read-safe degraded mode instead of losing data.
- With the pipeline you are always on the latest green `main`. To pin a version, set `BRANCH` to a branch or tag you control, or stop the timer.

## Running without Docker

Node 22 or newer, no `npm install`.

```sh
mkdir -p ~/workboard-instance && cd ~/workboard-instance      # cwd must contain (or will get) data/
set -a; . ./.env; set +a                                      # or pass variables however you prefer
HOST=127.0.0.1 PORT=4173 node ~/personal-workboard/server/index.js
```

The server uses `process.cwd()/data` as its data directory and serves `public/` from the checkout. Run it under systemd or another supervisor, as an unprivileged user, and put the same reverse proxy in front of it. Remember `WORKBOARD_HOSTS`. Run only one instance per data directory.

For a local trial without pairing (loopback only): `WORKBOARD_DEV_NO_AUTH=1 node server/index.js`, then open `http://127.0.0.1:4173`. This is refused unless `HOST` is a loopback address.
