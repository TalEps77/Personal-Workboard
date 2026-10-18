#!/usr/bin/env bash
# Safe pull-and-deploy for a self-hosted Workboard. Run it every few minutes (cron or the systemd timer next to
# this file) and by hand. It deploys a new commit only when ALL of these hold:
#   1. it is on origin/$BRANCH and a fast-forward of what is running (no rewritten history),
#   2. the REQUIRED GitHub checks (by name) for that exact commit finished green,
#   3. it does not touch the deployment machinery (deploy/, compose.yml, Dockerfile, .dockerignore, .github/) —
#      such commits wait for a human: review the diff, then run once with FORCE=1,
#   4. the unit tests pass again here, in a throwaway container without network, from that checkout,
#   5. the new container reports healthy — otherwise the previous image is started again.
# Run THIS SCRIPT FROM A PINNED COPY outside the checkout (e.g. $INSTANCE_DIR/bin/update.sh), so a new commit can
# never change the code that decides whether to deploy it. Update the copy by hand after reviewing it.
# The checkout is deploy-only: never edited, no write credential (the repository is public; fetch is anonymous HTTPS).
#
# Configuration (environment, or a file given as $1 that sets these):
#   INSTANCE_DIR   required — holds .env, data/, optional compose.override.yml; logs go here too
#   REPO_DIR       this checkout (default: the directory above this script)
#   BRANCH         default main
#   GITHUB_REPO    owner/name for the CI check (default: parsed from the origin URL)
#   REQUIRE_CI     1 (default) | 0
#   REQUIRED_CHECKS  comma-separated check names that must all be present and green
#                  (default "Unit tests,Browser tests (Chromium)")
#   MANUAL_PATHS   paths whose change needs FORCE=1 (default "deploy/ compose.yml Dockerfile .dockerignore .github/")
#   FORCE          1 = deploy a commit that touches MANUAL_PATHS (after you reviewed it)
#   NODE_IMAGE     image for the test run (default node:22-alpine)
#   KEEP_IMAGES    old images to keep for rollback (default 3)
set -uo pipefail
[ -n "${1:-}" ] && [ -f "$1" ] && . "$1"
REPO_DIR=${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
: "${INSTANCE_DIR:?set INSTANCE_DIR (directory with .env and data/)}"
BRANCH=${BRANCH:-main}
REQUIRE_CI=${REQUIRE_CI:-1}
REQUIRED_CHECKS=${REQUIRED_CHECKS:-Unit tests,Browser tests (Chromium)}
MANUAL_PATHS=${MANUAL_PATHS:-deploy/ compose.yml Dockerfile .dockerignore .github/}
FORCE=${FORCE:-0}
NODE_IMAGE=${NODE_IMAGE:-node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402}
KEEP_IMAGES=${KEEP_IMAGES:-3}
LOG="$INSTANCE_DIR/deploy.log"
LAST="$INSTANCE_DIR/last-deployed"
ENV_FILE="$INSTANCE_DIR/.env"

exec 9>"$INSTANCE_DIR/.deploy.lock"; flock -n 9 || exit 0
cd "$REPO_DIR" || exit 1
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
# A stuck state repeats its warning at most hourly instead of scrolling past once.
warn() {
  local f="$INSTANCE_DIR/.warn-$1" now last
  now=$(date +%s); last=$(cat "$f" 2>/dev/null || echo 0)
  if [ $((now - last)) -ge 3600 ]; then log "WARN $2"; echo "$now" > "$f"; fi
}
clear_warn() { rm -f "$INSTANCE_DIR/.warn-$1"; }
envval() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//; s/^"//; s/"$//'; }
compose() {
  local files=(-f compose.yml)
  [ -f "$INSTANCE_DIR/compose.override.yml" ] && files+=(-f "$INSTANCE_DIR/compose.override.yml")
  docker compose -p workboard "${files[@]}" --env-file "$ENV_FILE" "$@"
}
PORT=$(envval WORKBOARD_PORT); PORT=${PORT:-3000}
BIND=$(envval WORKBOARD_BIND); BIND=${BIND:-127.0.0.1}; [ "$BIND" = "0.0.0.0" ] && BIND=127.0.0.1
healthy() {
  local i
  for i in $(seq 1 30); do
    curl -fsS --max-time 3 -H 'Host: localhost' "http://$BIND:$PORT/api/health" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# 1. What is on GitHub.
if ! timeout 90 git fetch --quiet origin "$BRANCH" 2>>"$LOG"; then warn fetch "git fetch failed — still serving $(cat "$LAST" 2>/dev/null | cut -c1-12)"; exit 0; fi
clear_warn fetch
TARGET=$(git rev-parse "origin/$BRANCH")
CURRENT=$(cat "$LAST" 2>/dev/null || true)
[ "$TARGET" = "$CURRENT" ] && exit 0
SHORT=${TARGET:0:12}
# A commit that already failed here is not retried every few minutes.
[ "$(cat "$INSTANCE_DIR/.failed-sha" 2>/dev/null)" = "$TARGET" ] && [ "$FORCE" != "1" ] && exit 0
case "$REPO_DIR/" in "$(cd "$(dirname "$0")" && pwd)/"*) warn pinned "update.sh runs from inside the checkout — run a pinned copy instead (see the header)";; esac

# 2. Fast-forward only: a rewritten branch is never deployed automatically.
if [ -n "$CURRENT" ] && ! git merge-base --is-ancestor "$CURRENT" "$TARGET" 2>/dev/null; then
  warn ff "origin/$BRANCH ($SHORT) is not a fast-forward of the deployed ${CURRENT:0:12} — refusing. Deploy by hand if intended."
  exit 0
fi
clear_warn ff

# 3. CI must be green for this exact commit.
if [ "$REQUIRE_CI" = "1" ]; then
  REPO_SLUG=${GITHUB_REPO:-$(git remote get-url origin | sed -E 's#(git@[^:]+:|https://[^/]+/)##; s#\.git$##')}
  export REQUIRED_CHECKS
  RUNS=$(curl -fsS --max-time 20 -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO_SLUG/commits/$TARGET/check-runs?per_page=100" 2>/dev/null)
  VERDICT=$(printf '%s' "$RUNS" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const runs = JSON.parse(s).check_runs || [];
        const need = process.env.REQUIRED_CHECKS.split(",").map((x) => x.trim()).filter(Boolean);
        // Every required check must exist for this commit (a commit cannot pass by deleting its own CI jobs).
        const latest = (name) => runs.filter((r) => r.name === name).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
        const missing = need.filter((n) => !latest(n));
        if (missing.length) return console.log(runs.length && runs.every((r) => r.status === "completed") ? `missing:${missing.join(",")}` : "pending");
        if (need.some((n) => latest(n).status !== "completed")) return console.log("pending");
        const bad = need.filter((n) => latest(n).conclusion !== "success");
        console.log(bad.length ? `failed:${bad.join(",")}` : "success");
      } catch { console.log("unknown"); }
    });' 2>/dev/null || echo unknown)
  case "$VERDICT" in
    success) clear_warn ci ;;
    pending) exit 0 ;;   # try again next run
    *) warn ci "CI for $SHORT is '$VERDICT' — not deploying."; exit 0 ;;
  esac
fi

# 3b. Changes to the deployment machinery are never applied automatically.
if [ -n "$CURRENT" ] && [ "$FORCE" != "1" ]; then
  # shellcheck disable=SC2086
  TOUCHED=$(git diff --name-only "$CURRENT" "$TARGET" -- $MANUAL_PATHS | tr '\n' ' ')
  if [ -n "$TOUCHED" ]; then
    warn manual "$SHORT changes deployment files ($TOUCHED) — review the diff, update the pinned update.sh if needed, then run once with FORCE=1"
    exit 0
  fi
fi
clear_warn manual

# 4. Tests again, here, from that commit (the running container is unaffected: the code is baked into its image).
git checkout --quiet --detach "$TARGET" || { warn checkout "cannot check out $SHORT"; exit 0; }
if ! timeout 600 docker run --rm --network none -v "$REPO_DIR":/app:ro -w /app "$NODE_IMAGE" node --test --test-timeout=20000 'tests/*.test.js' >>"$LOG" 2>&1; then
  warn tests "unit tests fail on $SHORT — not deploying, still serving ${CURRENT:0:12}"
  echo "$TARGET" > "$INSTANCE_DIR/.failed-sha"
  [ -n "$CURRENT" ] && git checkout --quiet --detach "$CURRENT"
  exit 0
fi
clear_warn tests

# 5. Build and start; roll back if it doesn't come up healthy.
log "deploying $SHORT (was ${CURRENT:0:12})"
if WORKBOARD_IMAGE="workboard:$SHORT" timeout 900 compose up -d --build --remove-orphans >>"$LOG" 2>&1 && healthy; then
  echo "$TARGET" > "$LAST"
  log "deployed $SHORT"
  # Keep a few previous images for rollback.
  docker images --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' workboard | sort -k2 -r | awk 'NR>'"$KEEP_IMAGES"' {print $1}' | grep -v ':local$' | xargs -r docker rmi >/dev/null 2>&1 || true
  exit 0
fi
log "ERROR $SHORT did not come up healthy — rolling back to ${CURRENT:0:12}"
echo "$TARGET" > "$INSTANCE_DIR/.failed-sha"
if [ -z "$CURRENT" ]; then log "ERROR first deploy failed and there is nothing to roll back to — stopping it"; compose stop >>"$LOG" 2>&1; fi
if [ -n "$CURRENT" ]; then
  git checkout --quiet --detach "$CURRENT"
  WORKBOARD_IMAGE="workboard:${CURRENT:0:12}" compose up -d --no-build >>"$LOG" 2>&1 || WORKBOARD_IMAGE="workboard:${CURRENT:0:12}" compose up -d --build >>"$LOG" 2>&1
  healthy && log "rolled back to ${CURRENT:0:12}" || log "ERROR rollback did not come up healthy either — check by hand"
fi
exit 1
