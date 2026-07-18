#!/bin/bash
# Pre-deploy gate — every check must pass before anything ships.
# Run from the repo root:  bash tools/predeploy.sh
set -e
cd "$(dirname "$0")/.."
FAIL=0
step() { printf '%-38s' "$1"; }
ok()   { echo "OK"; }
bad()  { echo "FAIL"; FAIL=1; }

step "sw.js syntax (node --check)";        node --check sw.js                 && ok || bad
step "tools syntax";                       node --check tools/smoke.js && node --check tools/verify-themes.js && ok || bad
step "theme maps + contrast";              node tools/verify-themes.js >/dev/null && ok || bad
step "tabs_service unit+HTTP tests";       python3 tools/test_tabs_service.py 2>/dev/null >/dev/null && ok || bad
step "bctl_service syntax";                python3 -m py_compile server/bctl_service.py && ok || bad
step "tabs_service syntax";                python3 -m py_compile server/tabs_service.py && ok || bad

# SW cache-bump guard: shipping a changed index.html with an unchanged CACHE
# constant is how clients wedge on stale shells. Compared against the
# `deployed` tag (moved by tools/deploy.sh on every successful deploy).
step "sw cache bumped vs last deploy"
if git rev-parse -q --verify deployed >/dev/null 2>&1; then
  if ! git diff --quiet deployed -- index.html; then
    OLD=$(git show deployed:sw.js | grep -o 'term-shell-v[0-9]*' | head -1)
    NEW=$(grep -o 'term-shell-v[0-9]*' sw.js | head -1)
    if [ "$OLD" = "$NEW" ]; then bad; echo "  index.html changed but CACHE still $NEW"; else ok; fi
  else ok; fi
else echo "SKIP (no deployed tag yet)"; fi

[ $FAIL -eq 0 ] && echo "GATE: GREEN" || { echo "GATE: RED"; exit 1; }
