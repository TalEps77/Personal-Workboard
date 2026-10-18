#!/bin/sh
# Starts a throwaway board (auth disabled, loopback only, NO WhatsApp delivery) with seeded data and runs the browser
# suite against it.   PW_DIR=/tmp/pw tests/browser/run.sh
# Safety: webhook settings are stripped from the environment (nothing can reach Hermes/WhatsApp), the port is chosen
# free at random, and the health check must come from *this* server (it answers with our instance id).
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d /tmp/wb-e2e-XXXXXX)
cp -r "$here/server" "$here/public" "$here/package.json" "$work/"
# SUITE=spaces: two people (see tests/browser/people.json) — the multi-person suite.
suite=${SUITE:-suite}
if [ "$suite" = spaces ] || [ "$suite" = shots ] || [ "$suite" = zoom ]; then mkdir -p "$work/data" && cp "$here/tests/browser/people.json" "$work/data/people.json"; fi
port=${PORT:-$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")}
instance=$(basename "$work")
( cd "$work" && exec env -u HERMES_WEBHOOK_URL -u HERMES_WEBHOOK_SECRET -u HERMES_API_TOKEN -u WORKBOARD_EXTRA_TOKENS -u WORKBOARD_WEBHOOK_URL -u WORKBOARD_WEBHOOK_SECRET -u WORKBOARD_WEBHOOKS -u WORKBOARD_AGENT_TOKEN -u WORKBOARD_AGENT_TOKENS -u WORKBOARD_AGENTS -u WORKBOARD_SERVICE_TOKENS \
    WORKBOARD_DEV_NO_AUTH=1 WORKBOARD_INSTANCE="$instance" PORT="$port" HOST=127.0.0.1 node server/index.js > "$work/server.log" 2>&1 ) &
pid=$!
trap 'kill $pid 2>/dev/null; rm -rf "$work"' EXIT
ok=
for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$port/api/health" 2>/dev/null | grep -q "\"instance\":\"$instance\""; then ok=1; break; fi
  sleep 0.2
done
[ -n "$ok" ] || { echo "test server did not come up on port $port (or another server answered)"; cat "$work/server.log"; exit 1; }
PLAYWRIGHT_BROWSERS_PATH="${PW_DIR:-/tmp/pw}/browsers" BASE="http://127.0.0.1:$port" node "$here/tests/browser/$suite.mjs"
