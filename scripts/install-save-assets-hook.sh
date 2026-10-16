#!/usr/bin/env bash
# Run INSIDE the project whose new images should be uploaded (e.g. the CRM repo):
#   bash /path/to/assetsicon/scripts/install-save-assets-hook.sh [pre-push|post-commit]
# Installs the hook described in .claude/skills/save-assets/SKILL.md into this repo's .git/hooks (untracked).
set -eu
WHEN="${1:-pre-push}"
case "$WHEN" in pre-push|post-commit) ;; *) echo "usage: $0 [pre-push|post-commit]"; exit 1;; esac
SKILL="$(cd "$(dirname "$0")/.." && pwd)/.claude/skills/save-assets/SKILL.md"
HOOKS="$(git rev-parse --git-path hooks)" || { echo "Run this inside a git repository"; exit 1; }
HP="$(git config --get core.hooksPath || true)"; [ -n "$HP" ] && { echo "Note: core.hooksPath=$HP is set; installing there"; HOOKS="$HP"; }
mkdir -p "$HOOKS"

python3 - "$SKILL" "$HOOKS/save-assets.js" <<'PY'
import re, sys
md = open(sys.argv[1]).read()
js = re.search(r'### save-assets.js\n```js\n(.*?)\n```', md, re.S).group(1)
open(sys.argv[2], 'w').write(js + '\n')
PY

F="$HOOKS/$WHEN"
if [ -f "$F" ] && grep -q "# save-assets" "$F"; then echo "already in $F"; else
  [ -f "$F" ] || printf '#!/bin/sh\n' > "$F"
  if [ "$WHEN" = pre-push ]; then
    printf '\n# save-assets\n__r="$(cat)"; ( printf '"'"'%%s\\n'"'"' "$__r" | SA_WAIT_PID=$PPID SA_REMOTE="$1" node "$(dirname "$0")/save-assets.js" >/dev/null 2>&1 & ) >/dev/null 2>&1\n' >> "$F"
  else
    printf '\n# save-assets\n( SA_COMMIT=1 node "$(dirname "$0")/save-assets.js" >/dev/null 2>&1 & ) >/dev/null 2>&1\n' >> "$F"
  fi
  chmod +x "$F"
fi
echo "Installed $WHEN hook in $HOOKS (log: $(git rev-parse --git-dir)/save-assets.log)"
