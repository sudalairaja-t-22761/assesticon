#!/bin/bash
# Start the icon tool's npm publisher (scripts/npm-publisher.js) automatically on this Mac: at login, and again
# whenever it stops. Log: ~/Library/Logs/sf-npm-publisher.log
#
#   bash scripts/install-npm-publisher.sh            # the helper for the tool's page: npm login + publish when that admin pushes
#   bash scripts/install-npm-publisher.sh --watch    # also the 60 s check, which publishes by itself with THIS machine's saved npm login
#   bash scripts/install-npm-publisher.sh --remove   # stop and remove
#
# Needed on the machine: office network / VPN, a saved git login for zrepository.zohocorpcloud.in with push access, and
# RELEASE_NOTIFY_URL + RELEASE_NOTIFY_TOKEN in functions/spriteForgeJoin/.env or ~/.config/sf-npm-publisher.env.
# The npm login is done from the tool's page ("npm login" on a request) or with "npm login --registry <registry>".
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

MODE_ARGS=""
MODE_TEXT="helper for the tool's page only (publishes when an admin logs in and pushes a request)"
if [ "${1:-}" = "--watch" ]; then
  MODE_ARGS="<string>--watch</string>"
  MODE_TEXT="helper for the tool's page + the 60 s check with this machine's saved npm login"
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
  <array><string>$NODE</string><string>$ROOT/scripts/npm-publisher.js</string>$MODE_ARGS</array>
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
echo "npm publisher installed ($MODE_TEXT): starts at login and restarts if it stops."
echo "  log:    tail -f $LOG"
echo "  remove: bash scripts/install-npm-publisher.sh --remove"
