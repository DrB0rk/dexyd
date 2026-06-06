#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  LINK_TARGET="$(readlink "$SCRIPT_PATH")"
  if [[ "$LINK_TARGET" == /* ]]; then
    SCRIPT_PATH="$LINK_TARGET"
  else
    SCRIPT_PATH="$SCRIPT_DIR/$LINK_TARGET"
  fi
done

ROOT_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
cd "$ROOT_DIR"

CONFIG_PATH="${DEXYD_CONFIG:-$ROOT_DIR/dexyd.config.yaml}"
CLOUDFLARE_DIR="$ROOT_DIR/.dexyd/cloudflared"
CLOUDFLARE_CONFIG="$CLOUDFLARE_DIR/config.yml"
CLOUDFLARE_PID="$CLOUDFLARE_DIR/cloudflared.pid"

BRIDGE_PID=""
TUNNEL_PID=""

log() {
  printf '[dexyd-service] %s\n' "$*"
}

cleanup() {
  local pid
  for pid in "$TUNNEL_PID" "$BRIDGE_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  rm -f "$CLOUDFLARE_PID"
}

trap cleanup INT TERM EXIT

config_port() {
  python3 - "$CONFIG_PATH" <<'PY' 2>/dev/null || printf '4242\n'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8") if path.exists() else ""
match = re.search(r"(?ms)^server:\s*\n(?P<body>.*?)(?=^[A-Za-z_][A-Za-z0-9_]*:\s*$|\Z)", text)
body = match.group("body") if match else text
port = re.search(r"(?m)^\s*port:\s*(\d+)\s*$", body)
print(port.group(1) if port else "4242")
PY
}

wait_for_bridge() {
  local port="$1"
  local url="http://127.0.0.1:${port}/health/ready"
  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    if [[ -n "$BRIDGE_PID" ]] && ! kill -0 "$BRIDGE_PID" >/dev/null 2>&1; then
      return 1
    fi
    sleep 1
  done
  return 1
}

cloudflared_bin() {
  if command -v cloudflared >/dev/null 2>&1; then
    command -v cloudflared
    return 0
  fi
  if [[ -x "$HOME/.local/bin/cloudflared" ]]; then
    printf '%s\n' "$HOME/.local/bin/cloudflared"
    return 0
  fi
  return 1
}

if [[ ! -f "$ROOT_DIR/dist/index.js" ]]; then
  log "Bridge build missing; run dexyd --install first."
  exit 1
fi

log "Starting bridge"
NODE_BIN="${DEXYD_NODE_BINARY:-node}"
"$NODE_BIN" --enable-source-maps "$ROOT_DIR/dist/index.js" &
BRIDGE_PID="$!"

if [[ -f "$CLOUDFLARE_CONFIG" ]]; then
  if ! wait_for_bridge "$(config_port)"; then
    log "Bridge did not become ready; not starting tunnel."
    wait "$BRIDGE_PID"
    exit $?
  fi

  if CLOUDFLARED="$(cloudflared_bin)"; then
    mkdir -p "$CLOUDFLARE_DIR"
    log "Starting Cloudflare tunnel"
    "$CLOUDFLARED" --config "$CLOUDFLARE_CONFIG" tunnel run &
    TUNNEL_PID="$!"
    printf '%s\n' "$TUNNEL_PID" > "$CLOUDFLARE_PID"
  else
    log "Cloudflare tunnel config exists but cloudflared is not installed."
  fi
fi

if [[ -n "$TUNNEL_PID" ]]; then
  wait -n "$BRIDGE_PID" "$TUNNEL_PID"
else
  wait "$BRIDGE_PID"
fi
