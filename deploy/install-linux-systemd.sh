#!/usr/bin/env bash
# Installs the watcher as a systemd *user* service and enables lingering so it runs without a login session.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
UNIT_DIR="$HOME/.config/systemd/user"

command -v cswap >/dev/null || { echo "cswap not found (see README: uv tool install claude-swap)"; exit 1; }
command -v claude >/dev/null || { echo "claude (Claude Code CLI) not found on PATH"; exit 1; }

mkdir -p "$UNIT_DIR"
sed -e "s#@APP_DIR@#$APP_DIR#g" -e "s#@NODE_BIN@#$NODE_BIN#g" -e "s#@HOME@#$HOME#g" \
  "$APP_DIR/deploy/cswap-token-autoswap.service" > "$UNIT_DIR/cswap-token-autoswap.service"

loginctl enable-linger "$USER" 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable --now cswap-token-autoswap.service
systemctl --user --no-pager status cswap-token-autoswap.service | head -5
