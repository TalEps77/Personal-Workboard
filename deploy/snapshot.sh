#!/bin/sh
# Optional: keep a local git history of the instance data (tasks are readable Markdown files), so any change can be
# inspected or rolled back. Run hourly from cron:  DATA_DIR=/path/to/data deploy/snapshot.sh
# The data repository is local and private — never add a remote to it.
set -eu
: "${DATA_DIR:?set DATA_DIR to the instance data directory}"
cd "$DATA_DIR"
if [ ! -d .git ]; then
  git init --quiet
  printf 'runtime/\ntrash/\n' > .gitignore
fi
[ -n "$(git status --porcelain)" ] || exit 0
[ -e .git/index.lock ] && exit 0
git add -A
git -c user.name="${SNAPSHOT_NAME:-Workboard snapshot}" -c user.email="${SNAPSHOT_EMAIL:-workboard@localhost}" \
  commit --quiet -m "snapshot $(date '+%Y-%m-%d %H:%M')"
