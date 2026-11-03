#!/bin/bash
# Start the icon tool's npm publisher (scripts/npm-publisher.js) automatically on this Mac: at login, and again
# whenever it stops. Log: ~/Library/Logs/sf-npm-publisher.log
#
#   bash scripts/install-npm-publisher.sh            # install / update and start
#   bash scripts/install-npm-publisher.sh --remove   # stop and remove
set -euo pipefail

LABEL="com.spriteforge.npm-publisher"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/sf-npm-publisher.log"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "--remove" ]; then
  rm -f "$PLIST"
  echo "npm publisher stopped and removed."
  exit 0
fi

NODE="$(command -v node)"
[ -n "$NODE" ] || { echo "node not found on PATH"; exit 1; }
NPM_DIR="$(dirname "$(command -v npm)")"
GIT_DIR="$(dirname "$(command -v git)")"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$ROOT/scripts/npm-publisher.js</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$NODE"):$NPM_DIR:$GIT_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootstrap "$DOMAIN" "$PLIST"
echo "npm publisher installed: starts at login and restarts if it stops."
echo "  log:    tail -f $LOG"
echo "  remove: bash scripts/install-npm-publisher.sh --remove"
