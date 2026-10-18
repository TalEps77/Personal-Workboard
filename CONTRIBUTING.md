# Contributing

Thanks for helping. Workboard is a small, dependency-free project, and the guidelines below keep it that way.

## Dev setup

Requirements: **Node 22 or newer**. There is nothing to install: no `npm install`, no build step.

```sh
git clone https://github.com/TalEps77/Personal-Workboard.git
cd Personal-Workboard
WORKBOARD_DEV_NO_AUTH=1 node server/index.js      # http://127.0.0.1:4173, no pairing, loopback only
```

The server uses `./data` as its data directory (created on first start). Use a scratch directory or the throwaway board the browser tests start, not real data. `WORKBOARD_DEV_NO_AUTH=1` is refused unless the server binds to loopback. Edit files under `public/` and reload; the server picks them up as they are.

Layout: `server/` (API, storage, scheduler, MCP), `public/` (the app), `tests/`, `deploy/`, `examples/`, `docs/`. Read [docs/architecture.md](docs/architecture.md) first.

## Tests

```sh
npm test            # unit and API tests: node --test over tests/*.test.js
npm run check       # syntax check (node --check) of every server and client file
```

Unit tests boot isolated apps in temporary directories with a fake notifier; they never touch your data or send messages.

Browser suites use Playwright, which is kept **outside the repository** so the project stays dependency-free:

```sh
mkdir -p /tmp/pw && cd /tmp/pw && npm init -y && npm i playwright
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw/browsers npx playwright install chromium-headless-shell

cd /path/to/Personal-Workboard
PW_DIR=/tmp/pw tests/browser/run.sh                  # the main suite
SUITE=spaces PW_DIR=/tmp/pw tests/browser/run.sh     # two people, spaces and scoping
SUITE=zoom   PW_DIR=/tmp/pw tests/browser/run.sh     # phone-sized zoom and layout checks
SUITE=shots  PW_DIR=/tmp/pw tests/browser/run.sh     # screenshots
```

`run.sh` copies the app to a temporary directory, starts it on a free loopback port with authentication disabled, seeds data and runs the chosen suite (`suite`, `spaces`, `zoom`, `shots`), then deletes everything. It strips every webhook and token variable (`WORKBOARD_WEBHOOK*`, `WORKBOARD_AGENT_TOKEN*`, `WORKBOARD_SERVICE_TOKENS` and the older `HERMES_*` names) from the environment, so a test run can never reach a real agent.

A change that touches behaviour needs a unit test; a change to the interface needs the relevant browser suite to pass, and a look at it in both a desktop and a phone-sized viewport, in light and dark mode.

## Code style

- **Zero dependencies.** Do not add a package, a CDN link or a build step. Server code uses `node:*` modules; client code is plain ES modules.
- **RTL and logical CSS.** The interface is Hebrew-first. Use logical properties (`margin-inline-start`, `padding-inline`, `inset-inline-end`, `text-align: start`, `inline-size`) and never `left`/`right`. Flip directional icons and progress that runs "forward in time". Test with Hebrew and Latin text, and with mixed text.
- **Apple HIG feel.** Follow the patterns in `public/design-system.html`: tokens from the CSS custom properties, spring motion that can be interrupted, respect `prefers-reduced-motion`, light and dark themes.
- **Comments explain why**, not what. Keep the existing short, plain style; avoid commenting the obvious.
- **Files are the database.** Writes go through `writeAtomic`, run under the shared lock, and tasks keep their human-readable format. Validate input at the edge and fail with a clear message.
- **Logic keys off categories**, never off user-defined status ids.
- **No secrets or personal data in code, tests, fixtures or docs.** Use neutral example names (`alex`, `sam`) and `board.example.com`.
- Keep functions small and files focused; match the formatting of the file you edit.

## Pull request checklist

- [ ] `npm test` and `npm run check` pass (and `npm run docs:check` if you touched an MCP tool).
- [ ] Browser suite(s) pass for interface changes.
- [ ] New behaviour has a test; a fixed bug has a regression test.
- [ ] Works right-to-left and with a person of either `gender` setting; no physical `left`/`right` in CSS.
- [ ] No new dependency, no network call at start-up, no analytics.
- [ ] Docs updated if you changed an environment variable, an endpoint, a file format or the deploy scripts.
- [ ] No real names, hosts, IP addresses, tokens, `.env` or `data/` in the diff.
- [ ] Security-relevant change (auth, scoping, headers, deploy)? Say so in the description.

## Commit style

Short imperative subject with an optional type prefix, then a body that says why. Use `fix:`, `feat:`, `docs:`, `test:` or `chore:`.

```
fix: keep reminders on their local time across a DST change

The anchor was recomputed from the UTC value, so a 09:00 reminder drifted to 10:00
after the clock change. Store the wall-clock anchor and derive from it.
```

One logical change per commit. Do not rewrite history on `main`.

## Privacy rule

This is a public repository and the project handles personal data. Never commit:

- anything from a real `data/` directory (tasks, schedule, shopping lists, `people.json` with real people);
- `.env` or any secret, token, webhook URL with a secret, or pairing code;
- real names, phone numbers, host names, IP addresses or file paths from your own deployment, including in screenshots and test fixtures.

`.gitignore` excludes `.env*`, `data/` and `compose.override.yml`. Still, keep your instance directory outside the checkout. If you commit something private by mistake, tell the maintainers right away so the history can be cleaned: a later commit does not remove it.

## How the deploy pipeline treats `main`

Maintainers and self-hosters run `deploy/update.sh`, which follows `origin/main`. A commit is deployed only if it is a fast-forward of what is running, GitHub's checks for that exact commit are green, the unit tests pass again on the host, and the new container is healthy ([docs/deploy.md](docs/deploy.md)). Consequences for contributors:

- Open a pull request; do not push to `main`. `main` is protected and requires passing CI.
- A red CI run blocks deployment everywhere, so keep tests fast and deterministic.
- Never force-push `main`: followers will refuse to deploy it and a human has to step in.
- Merging is a release. Expect running instances to update within minutes.
