#!/usr/bin/env bash
set -euo pipefail

DEXYD_REPO_URL_DEFAULT="https://github.com/DrB0rk/dexyd.git"
DEXYD_BRANCH_DEFAULT="main"
DEXYD_APP_ID="dexyd"
DEXYD_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
DEXYD_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DEXYD_BIN_HOME="${HOME}/.local/bin"
DEXYD_INSTALL_DIR_DEFAULT="${DEXYD_DATA_HOME}/${DEXYD_APP_ID}"

REPO_URL="${DEXYD_REPO_URL:-$DEXYD_REPO_URL_DEFAULT}"
BRANCH="${DEXYD_BRANCH:-$DEXYD_BRANCH_DEFAULT}"
INSTALL_DIR="${DEXYD_INSTALL_DIR:-$DEXYD_INSTALL_DIR_DEFAULT}"
INSTALL_SERVICE=1
OPEN_FIREWALL=0
USE_CURRENT=0
CLEAN_ONLY=0

if [[ -t 1 ]]; then
  bold() { printf '\033[1m%s\033[0m\n' "$*"; }
  dim() { printf '\033[2m%s\033[0m\n' "$*"; }
else
  bold() { printf '%s\n' "$*"; }
  dim() { printf '%s\n' "$*"; }
fi
ok() { printf '✓ %s\n' "$*"; }
warn() { printf '! %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<USAGE
Dexyd installer

Usage:
  bash scripts/install.sh [options]
  curl -fsSL https://raw.githubusercontent.com/DrB0rk/dexyd/main/scripts/install.sh | bash

Options:
  --repo <url>       Git repository URL. Default: $DEXYD_REPO_URL_DEFAULT
  --branch <name>    Git branch/tag to install. Default: $DEXYD_BRANCH_DEFAULT
  --dir <path>       App install directory. Default: $DEXYD_INSTALL_DIR_DEFAULT
  --use-current      Copy the current checkout into the app install directory.
  --no-service       Do not install/start the user systemd service.
  --firewall         Open bridge port 4242 in a supported Linux firewall.
  --clean            Remove installed Dexyd app/service/command and exit.
  --yes, -y          Compatibility no-op; installer is non-interactive.
  --help, -h         Show this help.

Environment overrides:
  DEXYD_REPO_URL, DEXYD_BRANCH, DEXYD_INSTALL_DIR
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_URL="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --use-current) USE_CURRENT=1; shift ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    --service) INSTALL_SERVICE=1; shift ;;
    --firewall) OPEN_FIREWALL=1; shift ;;
    --clean) CLEAN_ONLY=1; shift ;;
    --yes|-y) shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

expand_path() {
  python3 - "$1" <<'PY'
from pathlib import Path
import os, sys
print(Path(os.path.expandvars(os.path.expanduser(sys.argv[1]))).resolve())
PY
}

INSTALL_DIR="$(expand_path "$INSTALL_DIR")"
COMMAND_PATH="${DEXYD_BIN_HOME}/dexyd"
SERVICE_DIR="${DEXYD_CONFIG_HOME}/systemd/user"
SERVICE_PATH="${SERVICE_DIR}/dexyd.service"
SERVICE_LINK="${SERVICE_DIR}/default.target.wants/dexyd.service"

run_sudo() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  elif has sudo; then
    sudo "$@"
  else
    fail "sudo is required to install missing system packages. Install dependencies manually and rerun."
  fi
}

detect_pm() {
  if has apt-get; then echo apt; return; fi
  if has dnf; then echo dnf; return; fi
  if has pacman; then echo pacman; return; fi
  if has zypper; then echo zypper; return; fi
  echo unknown
}

install_packages() {
  local pm="$1"
  case "$pm" in
    apt)
      run_sudo apt-get update
      run_sudo apt-get install -y git curl ca-certificates nodejs npm python3 python3-venv python3-pip
      ;;
    dnf)
      run_sudo dnf install -y git curl ca-certificates nodejs npm python3 python3-pip
      ;;
    pacman)
      run_sudo pacman -S --needed --noconfirm git curl ca-certificates nodejs npm python python-pip
      ;;
    zypper)
      run_sudo zypper install -y git curl ca-certificates nodejs npm python3 python3-pip
      ;;
    *) return 1 ;;
  esac
}

node_major() {
  if ! has node; then echo 0; return; fi
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0
}

check_core_dependencies() {
  local missing=() major pm
  for cmd in git curl node npm python3; do
    has "$cmd" || missing+=("$cmd")
  done

  major="$(node_major)"
  if (( ${#missing[@]} > 0 || major < 20 )); then
    if (( major > 0 && major < 20 )); then
      warn "Node.js $(node --version) detected; Dexyd requires Node.js 20+."
    else
      warn "Missing dependencies: ${missing[*]:-none}"
    fi
    pm="$(detect_pm)"
    if [[ "$pm" != "unknown" ]]; then
      dim "Installing/refreshing system packages with $pm"
      install_packages "$pm" || true
    else
      warn "No supported package manager found. Install git, curl, Node.js 20+, npm, python3, and python3-venv manually."
    fi
  fi

  for cmd in git curl node npm python3; do
    has "$cmd" || fail "$cmd is required. Install it and rerun the installer."
  done
  major="$(node_major)"
  (( major >= 20 )) || fail "Node.js 20+ is required. Current: $(node --version 2>/dev/null || echo missing). Install Node 20+ and rerun."
  python3 -m venv --help >/dev/null 2>&1 || fail "python3 venv support is required. Install python3-venv and rerun."
  ok "Core dependencies ready"
}

stop_service() {
  if has systemctl; then
    systemctl --user disable --now dexyd.service >/dev/null 2>&1 || true
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
}

cleanup_old_install() {
  local clean_app_dir="${1:-0}"
  stop_service
  rm -f "$SERVICE_LINK" "$SERVICE_PATH" "$COMMAND_PATH"
  if [[ "$clean_app_dir" == "1" ]]; then
    rm -rf "$INSTALL_DIR"
  fi
  ok "Removed old Dexyd service/command${clean_app_dir:+/app directory}"
}

looks_like_dexyd_dir() {
  local dir="$1"
  [[ -d "$dir" && ( -f "$dir/package.json" || -f "$dir/bin/dexyd" || -d "$dir/src" || -f "$dir/dexyd.config.yaml" ) ]]
}

safe_prepare_install_dir() {
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [[ -e "$INSTALL_DIR" && ! -d "$INSTALL_DIR" ]]; then
    fail "$INSTALL_DIR exists and is not a directory. Choose another --dir."
  fi
  if [[ -d "$INSTALL_DIR" && ! -d "$INSTALL_DIR/.git" && "$USE_CURRENT" != "1" ]]; then
    if looks_like_dexyd_dir "$INSTALL_DIR"; then
      warn "Replacing existing non-git Dexyd install at $INSTALL_DIR"
      rm -rf "$INSTALL_DIR"
    elif [[ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)" ]]; then
      fail "$INSTALL_DIR exists and is not a Dexyd install. Choose another --dir."
    fi
  fi
}

deploy_current_checkout() {
  local source_root="$1" target_root="$2"
  python3 - "$source_root" "$target_root" <<'PY'
from pathlib import Path
import shutil
import sys

source = Path(sys.argv[1]).resolve()
target = Path(sys.argv[2]).resolve()
if not (source / 'package.json').exists() or not (source / 'src').is_dir():
    raise SystemExit('--use-current must be run from the Dexyd repository root')
if source == target:
    print(target)
    raise SystemExit(0)
if target in source.parents:
    raise SystemExit(f'Install directory cannot be inside the source checkout: {target}')

exclude_names = {
    '.git', '.github', '.omx', '.dexyd', 'dev', 'mobile', 'node_modules',
    'test', 'dist', 'coverage', '.gradle', 'build', '.cache', 'tmp', 'temp',
    'dexyd.config.yaml'
}
preserve_names = {'.dexyd', 'dexyd.config.yaml'}

target.mkdir(parents=True, exist_ok=True)
for child in list(target.iterdir()):
    if child.name in preserve_names:
        continue
    if child.is_dir() and not child.is_symlink():
        shutil.rmtree(child)
    else:
        child.unlink()

def ignore(directory, names):
    return [name for name in names if name in exclude_names]

for child in source.iterdir():
    if child.name in exclude_names:
        continue
    dest = target / child.name
    if child.is_dir() and not child.is_symlink():
        shutil.copytree(child, dest, ignore=ignore)
    else:
        shutil.copy2(child, dest, follow_symlinks=False)
print(target)
PY
}

resolve_source() {
  safe_prepare_install_dir
  if [[ "$USE_CURRENT" == "1" ]]; then
    bold "Deploying current checkout into $INSTALL_DIR" >&2
    deploy_current_checkout "$(pwd)" "$INSTALL_DIR" >/dev/null
    echo "$INSTALL_DIR"
    return
  fi

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    bold "Updating Dexyd in $INSTALL_DIR" >&2
    git -C "$INSTALL_DIR" remote set-url origin "$REPO_URL" 2>/dev/null || true
    git -C "$INSTALL_DIR" fetch --prune origin >&2
    git -C "$INSTALL_DIR" checkout "$BRANCH" >&2
    git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH" >&2
  else
    bold "Cloning Dexyd into $INSTALL_DIR" >&2
    git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" >&2
  fi
  echo "$INSTALL_DIR"
}

validate_install_tree() {
  local root="$1"
  [[ -f "$root/package.json" ]] || fail "Installed tree is missing package.json at $root"
  [[ -f "$root/package-lock.json" ]] || warn "package-lock.json missing; npm install will be used instead of npm ci."
  [[ -f "$root/bin/dexyd" ]] || fail "Installed tree is missing bin/dexyd"
  [[ -f "$root/src/index.ts" ]] || fail "Installed tree is missing bridge source files"
  [[ -f "$root/tui/requirements.txt" ]] || fail "Installed tree is missing TUI requirements"
  [[ -f "$root/dexyd.config.example.yaml" ]] || fail "Installed tree is missing dexyd.config.example.yaml"
}

json_string() {
  python3 - "$1" <<'PY'
import json, sys
print(json.dumps(sys.argv[1]))
PY
}

write_config() {
  local root="$1" config="$root/dexyd.config.yaml" example="$root/dexyd.config.example.yaml"
  local workspace public_url signing_key
  if [[ ! -f "$config" ]]; then
    cp "$example" "$config"
    ok "Created $config"
  fi

  workspace="$HOME"
  public_url=""
  signing_key="$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
)"

  python3 - "$config" "$workspace" "$public_url" "$signing_key" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
workspace, public_url, generated_key = sys.argv[2:5]
s = path.read_text()

def replace_or_insert(section, key, value):
    global s
    pattern = rf'(?ms)^({re.escape(section)}:\n)(.*?)(?=^[A-Za-z_][A-Za-z0-9_]*:|\Z)'
    m = re.search(pattern, s)
    rendered = f'{key}: {value}'
    if not m:
        s += f'\n{section}:\n  {rendered}\n'
        return
    block = m.group(2)
    key_pattern = rf'(?m)^(\s*){re.escape(key)}:\s*.*$'
    if re.search(key_pattern, block):
        block = re.sub(key_pattern, lambda km: f'{km.group(1)}{rendered}', block, count=1)
    else:
        block = block.rstrip() + f'\n  {rendered}\n'
    s = s[:m.start(2)] + block + s[m.end(2):]

def current_scalar(key):
    m = re.search(rf'(?m)^\s*{re.escape(key)}:\s*([^\n#]+)', s)
    return (m.group(1).strip().strip('"\'') if m else '')

replace_or_insert('server', 'host', '0.0.0.0')
replace_or_insert('server', 'publicBaseUrl', repr(public_url).replace("'", '"'))
replace_or_insert('codex', 'workspaceRoot', repr(workspace).replace("'", '"'))

current_key = current_scalar('signingKey')
if current_key in {'', 'change-this-in-production-min-16-chars', 'dexyd-dev-change-me', 'test-signing-key-value'}:
    replace_or_insert('auth', 'signingKey', generated_key)

path.write_text(s)
PY
  ok "Configured $config"
}

install_bridge_deps() {
  local root="$1"
  cd "$root"
  if [[ -f package-lock.json ]]; then
    npm ci --no-audit --fund=false
  else
    npm install --no-audit --fund=false
  fi
  ok "Bridge dependencies installed"
}

build_bridge() {
  local root="$1"
  cd "$root"
  npm run build
  npm prune --omit=dev --no-audit --fund=false
  ok "Bridge built and runtime dependencies pruned"
}

install_tui_deps() {
  local root="$1"
  local venv="$root/.dexyd/.venv-tui"
  local req="$root/tui/requirements.txt"
  local marker="$venv/.deps-installed"
  local venv_bin="$venv/bin"
  local python_bin=""

  # When this installer is launched from the TUI updater, PATH may point at the
  # currently-running TUI virtualenv. We delete/recreate that venv below, so use
  # a Python executable outside it or the update can fail halfway through.
  while IFS= read -r candidate; do
    case "$candidate" in
      "$venv_bin"/*) continue ;;
      *) python_bin="$candidate"; break ;;
    esac
  done < <(type -P -a python3 2>/dev/null || true)
  [[ -n "$python_bin" ]] || fail "python3 is required to create the TUI virtualenv"

  rm -rf "$venv"
  hash -r 2>/dev/null || true
  mkdir -p "$(dirname "$venv")"
  "$python_bin" -m venv "$venv"
  [[ -x "$venv/bin/python" ]] || fail "TUI virtualenv did not create $venv/bin/python"
  if [[ ! -e "$venv/bin/python3" ]]; then
    ln -s python "$venv/bin/python3"
  fi
  PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1 "$venv/bin/python" -m pip install --upgrade pip
  PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1 "$venv/bin/python" -m pip install -r "$req"
  touch "$marker"
  ok "TUI dependencies installed"
}

install_command() {
  local root="$1"
  mkdir -p "$DEXYD_BIN_HOME"
  chmod +x "$root/bin/dexyd" "$root/scripts/install.sh"
  ln -sfn "$root/bin/dexyd" "$COMMAND_PATH"
  ok "Installed command: $COMMAND_PATH -> $root/bin/dexyd"
  case ":$PATH:" in
    *":$DEXYD_BIN_HOME:"*) ;;
    *) warn "$DEXYD_BIN_HOME is not in PATH. Add it to your shell profile or run $COMMAND_PATH directly." ;;
  esac
}

install_user_service() {
  local root="$1" config="$root/dexyd.config.yaml"
  if ! has systemctl; then
    warn "systemctl not found; skipping user service."
    return 0
  fi
  mkdir -p "$SERVICE_DIR"
  cat > "$SERVICE_PATH" <<SERVICE
[Unit]
Description=Dexyd bridge
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$root
Environment=DEXYD_CONFIG=$config
ExecStart=$root/bin/dexyd
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
SERVICE

  if ! systemctl --user daemon-reload; then
    warn "Could not reload user systemd. Service file was written to $SERVICE_PATH but not started."
    return 0
  fi
  if systemctl --user enable dexyd.service >/dev/null 2>&1 && systemctl --user restart dexyd.service >/dev/null 2>&1; then
    ok "Installed and started user service: dexyd.service"
  else
    warn "Service file installed but could not be enabled/started. Run: systemctl --user status dexyd.service"
  fi
}

open_bridge_firewall() {
  local port="4242"
  if has ufw; then
    local status
    status="$(ufw status 2>/dev/null || run_sudo ufw status 2>/dev/null || true)"
    if grep -qi '^Status: active' <<<"$status"; then
      run_sudo ufw allow "${port}/tcp" comment dexyd
      ok "Opened TCP $port with ufw"
      return 0
    fi
  fi
  if has firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
    run_sudo firewall-cmd --add-port="${port}/tcp" --permanent
    run_sudo firewall-cmd --reload
    ok "Opened TCP $port with firewalld"
    return 0
  fi
  warn "No active supported firewall manager found. Open TCP $port manually if LAN/tunnel access fails."
}

final_verify() {
  local root="$1"
  [[ -x "$root/bin/dexyd" ]] || fail "Installed wrapper is not executable"
  [[ -f "$root/dist/index.js" ]] || fail "Bridge build missing at $root/dist/index.js"
  [[ -x "$root/.dexyd/.venv-tui/bin/python" ]] || fail "TUI virtualenv missing"
  [[ -L "$COMMAND_PATH" ]] || fail "Command symlink was not created"
  local resolved
  resolved="$(readlink -f "$COMMAND_PATH")"
  [[ "$resolved" == "$root/bin/dexyd" ]] || fail "Command points to $resolved, expected $root/bin/dexyd"
  ok "Install verification passed"
}

main() {
  bold "Dexyd installer"
  dim "Repository: $REPO_URL"
  dim "Branch:     $BRANCH"
  dim "Install to: $INSTALL_DIR"

  if [[ "$CLEAN_ONLY" == "1" ]]; then
    cleanup_old_install 1
    exit 0
  fi

  check_core_dependencies
  cleanup_old_install 0

  local root
  root="$(resolve_source)"
  validate_install_tree "$root"
  write_config "$root"

  bold "Installing bridge dependencies"
  install_bridge_deps "$root"
  bold "Building bridge"
  build_bridge "$root"
  bold "Installing TUI dependencies"
  install_tui_deps "$root"

  install_command "$root"
  if [[ "$INSTALL_SERVICE" == "1" ]]; then
    install_user_service "$root"
  fi
  if [[ "$OPEN_FIREWALL" == "1" ]]; then
    open_bridge_firewall || true
  fi
  final_verify "$root"

  bold "Dexyd installed"
  printf '\nNext steps:\n'
  printf '  dexyd --tui                         # open setup/pairing UI\n'
  printf '  systemctl --user status dexyd.service # check service\n'
  printf '  dexyd                               # foreground bridge, if service is stopped\n'
}

main "$@"
