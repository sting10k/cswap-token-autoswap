#!/usr/bin/env bash
# Installs the watcher as a launchd LaunchAgent (starts at login, restarted if it exits).
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
LABEL="com.cswap-token-autoswap"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

command -v cswap >/dev/null || { echo "cswap not found (see README: uv tool install claude-swap)"; exit 1; }
command -v claude >/dev/null || { echo "claude (Claude Code CLI) not found on PATH"; exit 1; }

# launchd starts with a minimal PATH: include the dirs of node, cswap and claude explicitly
RUN_PATH="$(dirname "$NODE_BIN"):$(dirname "$(command -v cswap)"):$(dirname "$(command -v claude)"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN</string><string>$APP_DIR/token-autoswap-watcher.js</string></array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$RUN_PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$APP_DIR/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/launchd.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|pid" | head -3
