#!/bin/sh
# Pre-push guard for maintainers: refuses a push whose outgoing changes contain any line from a PRIVATE marker list
# (your names, host names, phone numbers, internal words). The list lives outside the repository:
#   ${WORKBOARD_PRIVATE_MARKERS:-$HOME/.config/workboard/private-markers.txt}   — one fixed string per line.
# Install:  ln -s ../../scripts/privacy-guard.sh .git/hooks/pre-push
set -eu
markers=${WORKBOARD_PRIVATE_MARKERS:-$HOME/.config/workboard/private-markers.txt}
[ -f "$markers" ] || { echo "privacy-guard: no marker list at $markers — skipping" >&2; exit 0; }
zero=0000000000000000000000000000000000000000
status=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$zero" ] && continue
  if [ "$remote_sha" = "$zero" ]; then range="$local_sha"; else range="$remote_sha..$local_sha"; fi
  # Added lines in the pushed commits, plus commit messages and author identities.
  hits=$( { git log --format='%an <%ae>%n%cn <%ce>%n%B' "$range"; git log -p --no-color --format= "$range" | grep '^+' ; } | grep -n -i -F -f "$markers" || true)
  if [ -n "$hits" ]; then
    echo "privacy-guard: refusing to push $local_ref — private markers found:" >&2
    echo "$hits" | cut -c1-160 | head -20 >&2
    status=1
  fi
done
exit $status
