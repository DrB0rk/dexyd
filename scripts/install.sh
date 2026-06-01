#!/usr/bin/env bash
set -euo pipefail

DEXYD_REPO_URL_DEFAULT="https://github.com/drb0rk/dexyd.git"
DEXYD_BRANCH_DEFAULT="main"
DEXYD_INSTALL_DIR_DEFAULT="$HOME/.local/share/dexyd"

REPO_URL="${DEXYD_REPO_URL:-$DEXYD_REPO_URL_DEFAULT}"
BRANCH="${DEXYD_BRANCH:-$DEXYD_BRANCH_DEFAULT}"
INSTALL_DIR="${DEXYD_INSTALL_DIR:-$DEXYD_INSTALL_DIR_DEFAULT}"
ASSUME_YES="${DEXYD_ASSUME_YES:-0}"
INSTALL_ANDROID=0
INSTALL_SERVICE=0
OPEN_FIREWALL=0
USE_CURRENT=0

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
  curl -fsSL https://raw.githubusercontent.com/drb0rk/dexyd/main/scripts/install.sh | bash

Options:
  --repo <url>       Git repository URL. Default: $DEXYD_REPO_URL_DEFAULT
  --branch <name>    Git branch/tag to install. Default: $DEXYD_BRANCH_DEFAULT
  --dir <path>       Install directory. Default: $DEXYD_INSTALL_DIR_DEFAULT
  --yes              Accept default answers.
  --android          Also install mobile deps and try an Android build.
  --service          Install/start the user systemd service.
  --firewall         Open bridge port in a supported Linux firewall.
  --use-current      Install from the current checkout instead of cloning.
  --help             Show this help.

Environment overrides:
  DEXYD_REPO_URL, DEXYD_BRANCH, DEXYD_INSTALL_DIR, DEXYD_ASSUME_YES=1
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_URL="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --android) INSTALL_ANDROID=1; shift ;;
    --service) INSTALL_SERVICE=1; shift ;;
    --firewall) OPEN_FIREWALL=1; shift ;;
    --use-current) USE_CURRENT=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

ask_yes_no() {
  local prompt="$1" default="${2:-y}" answer suffix
  if [[ "$ASSUME_YES" == "1" ]]; then
    [[ "$default" =~ ^[Yy]$ ]]
    return
  fi
  suffix='[Y/n]'
  [[ "$default" == "n" ]] && suffix='[y/N]'
  if [[ -r /dev/tty ]]; then
    read -r -p "$prompt $suffix " answer </dev/tty || true
  else
    answer="$default"
  fi
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy]$ ]]
}

ask_text() {
  local prompt="$1" default="${2:-}" answer
  [[ "$ASSUME_YES" == "1" ]] && { printf '%s\n' "$default"; return; }
  if [[ -r /dev/tty ]]; then
    read -r -p "$prompt [$default] " answer </dev/tty || true
  else
    answer="$default"
  fi
  printf '%s\n' "${answer:-$default}"
}

run_sudo() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

detect_pm() {
  if has apt-get; then echo apt; return; fi
  if has pacman; then echo pacman; return; fi
  if has dnf; then echo dnf; return; fi
  if has zypper; then echo zypper; return; fi
  echo unknown
}

install_packages() {
  local pm="$1" android="$2"
  case "$pm" in
    apt)
      run_sudo apt-get update
      if [[ "$android" == "1" ]]; then
        run_sudo apt-get install -y git curl ca-certificates nodejs npm python3 python3-venv python3-pip openjdk-17-jdk android-tools-adb
      else
        run_sudo apt-get install -y git curl ca-certificates nodejs npm python3 python3-venv python3-pip
      fi
      ;;
    pacman)
      if [[ "$android" == "1" ]]; then
        run_sudo pacman -S --needed git curl nodejs npm python python-pip jdk17-openjdk android-tools
      else
        run_sudo pacman -S --needed git curl nodejs npm python python-pip
      fi
      ;;
    dnf)
      if [[ "$android" == "1" ]]; then
        run_sudo dnf install -y git curl ca-certificates nodejs npm python3 python3-pip java-17-openjdk-devel android-tools
      else
        run_sudo dnf install -y git curl ca-certificates nodejs npm python3 python3-pip
      fi
      ;;
    zypper)
      if [[ "$android" == "1" ]]; then
        run_sudo zypper install -y git curl ca-certificates nodejs npm python3 python3-pip java-17-openjdk-devel android-tools
      else
        run_sudo zypper install -y git curl ca-certificates nodejs npm python3 python3-pip
      fi
      ;;
    *)
      warn "No supported package manager found. Install git, curl, Node.js 20+, npm, and Python 3 manually."
      ;;
  esac
}

node_major() {
  if ! has node; then echo 0; return; fi
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0
}

check_core_dependencies() {
  local missing=() pm major
  for cmd in git curl node npm python3; do
    has "$cmd" || missing+=("$cmd")
  done
  major="$(node_major)"
  if (( major > 0 && major < 20 )); then
    warn "Node.js $major detected; Dexyd bridge requires Node.js 20+ and mobile tooling prefers Node.js 22+."
  fi
  if (( ${#missing[@]} > 0 )) || (( major > 0 && major < 20 )); then
    warn "Missing/outdated core dependencies: ${missing[*]:-node-version}"
    pm="$(detect_pm)"
    if [[ "$pm" != "unknown" ]] && ask_yes_no "Install/refresh distro packages with $pm now?" y; then
      install_packages "$pm" "$INSTALL_ANDROID"
    fi
  fi
  for cmd in git curl node npm python3; do
    has "$cmd" || fail "$cmd is required. Install it and rerun the installer."
  done
  major="$(node_major)"
  (( major >= 20 )) || fail "Node.js 20+ is required. Current: $(node --version 2>/dev/null || echo missing)"
  ok "Core dependencies ready"
}

resolve_repo_root() {
  local source_dir=""
  if [[ "${BASH_SOURCE[0]}" != "bash" && -f "${BASH_SOURCE[0]}" ]]; then
    source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  fi

  if [[ "$USE_CURRENT" == "1" ]]; then
    [[ -f package.json ]] || fail "--use-current requires running from the Dexyd repository root."
    printf '%s\n' "$(pwd)"
    return
  fi

  if [[ -n "$source_dir" && -f "$source_dir/package.json" && -d "$source_dir/src" ]]; then
    if ask_yes_no "Use current checkout at $source_dir?" y; then
      printf '%s\n' "$source_dir"
      return
    fi
  elif [[ -f package.json && -d src ]] && ask_yes_no "Use current checkout at $(pwd)?" n; then
    printf '%s\n' "$(pwd)"
    return
  fi

  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    bold "Updating Dexyd in $INSTALL_DIR" >&2
    git -C "$INSTALL_DIR" fetch --prune origin >&2
    git -C "$INSTALL_DIR" checkout "$BRANCH" >&2
    git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH" >&2
  elif [[ -e "$INSTALL_DIR" ]]; then
    if [[ -f "$INSTALL_DIR/package.json" && -d "$INSTALL_DIR/src" ]]; then
      warn "$INSTALL_DIR exists and looks like a Dexyd checkout, but is not a git repo." >&2
      ask_yes_no "Use it anyway?" y || fail "Choose another --dir or remove $INSTALL_DIR."
    else
      fail "$INSTALL_DIR already exists and is not a Dexyd checkout. Choose another --dir."
    fi
  else
    bold "Cloning Dexyd into $INSTALL_DIR" >&2
    git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" >&2
  fi

  printf '%s\n' "$INSTALL_DIR"
}

write_config() {
  local root="$1"
  local config="$root/dexyd.config.yaml"
  local workspace public_url signing_key current_workspace current_public
  if [[ ! -f "$config" ]]; then
    cp "$root/dexyd.config.example.yaml" "$config"
    ok "Created dexyd.config.yaml"
  fi

  current_workspace="$(python3 - "$config" "$HOME" <<'PYCURRENTWORKSPACE'
from pathlib import Path
import re, sys
s = Path(sys.argv[1]).read_text()
m = re.search(r'(?m)^\s*workspaceRoot:\s*["\']?([^"\'\n#]+)', s)
print((m.group(1).strip() if m else sys.argv[2]) or sys.argv[2])
PYCURRENTWORKSPACE
)"
  current_public="$(python3 - "$config" <<'PYCURRENTPUBLIC'
from pathlib import Path
import re, sys
s = Path(sys.argv[1]).read_text()
m = re.search(r'(?m)^\s*publicBaseUrl:\s*["\']?([^"\'\n#]*)', s)
print((m.group(1).strip() if m else '').rstrip('/'))
PYCURRENTPUBLIC
)"

  workspace="$(ask_text "Workspace root" "$current_workspace")"
  public_url="$(ask_text "Public bridge URL for Caddy/Cloudflare, or blank for LAN" "$current_public")"
  signing_key="$(python3 - <<'PYKEY'
import secrets
print(secrets.token_urlsafe(48))
PYKEY
)"

  python3 - "$config" "$workspace" "$public_url" "$signing_key" <<'PYCONFIG'
from pathlib import Path
import re, sys
path = Path(sys.argv[1])
workspace, public_url, generated_signing_key = sys.argv[2:5]
s = path.read_text()
s = re.sub(r'(?m)^(\s*)host:\s*.*$', r'\1host: 0.0.0.0', s, count=1)
s = re.sub(r'(?m)^(\s*)publicBaseUrl:\s*.*$', lambda m: f'{m.group(1)}publicBaseUrl: "{public_url}"', s, count=1)
s = re.sub(r'(?m)^(\s*)workspaceRoot:\s*.*$', lambda m: f'{m.group(1)}workspaceRoot: {workspace}', s, count=1)
current = ''
m = re.search(r'(?m)^\s*signingKey:\s*([^\n#]+)', s)
if m:
    current = m.group(1).strip().strip('"\'')
if current in {'', 'change-this-in-production-min-16-chars', 'dexyd-dev-change-me'}:
    s = re.sub(r'(?m)^(\s*)signingKey:\s*.*$', lambda m: f'{m.group(1)}signingKey: {generated_signing_key}', s, count=1)
path.write_text(s)
PYCONFIG
  ok "Configured $config"
}

install_tui_deps() {
  local root="$1"
  local venv="$root/.dexyd/.venv-tui"
  local req="$root/tui/requirements.txt"
  [[ -f "$req" ]] || return 0
  python3 -m venv "$venv"
  "$venv/bin/python" -m pip install --upgrade pip
  "$venv/bin/python" -m pip install -r "$req"
  touch "$venv/.deps-installed"
  ok "TUI dependencies installed"
}

install_command() {
  local root="$1"
  local target_dir="$HOME/.local/bin"
  local target="$target_dir/dexyd"
  mkdir -p "$target_dir"
  ln -sfn "$root/bin/dexyd" "$target"
  ok "Installed command: $target"
  case ":$PATH:" in
    *":$target_dir:"*) ;;
    *) warn "$target_dir is not in PATH. Add it to your shell profile or run $target directly." ;;
  esac
}

install_user_service() {
  local root="$1"
  local config="$root/dexyd.config.yaml"
  local service_dir="$HOME/.config/systemd/user"
  local service="$service_dir/dexyd.service"
  has systemctl || { warn "systemctl not found; skipping service."; return 0; }
  mkdir -p "$service_dir"
  cat > "$service" <<SERVICE
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
  systemctl --user daemon-reload
  systemctl --user enable --now dexyd.service
  ok "Installed and started user service: dexyd.service"
}

open_bridge_firewall() {
  local port="${1:-4242}"
  if has ufw; then
    local status=""
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

  if has iptables; then
    run_sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null || \
      run_sudo iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
    warn "Opened TCP $port with a temporary iptables rule. Make it persistent with your distro firewall tools."
    return 0
  fi

  warn "No supported firewall manager found. Open TCP $port manually if LAN devices cannot connect."
  return 1
}

build_android_if_requested() {
  local root="$1"
  [[ "$INSTALL_ANDROID" == "1" ]] || ask_yes_no "Install mobile dependencies and build Android debug APK?" n || return 0
  INSTALL_ANDROID=1
  if ! has java || ! has adb; then
    warn "Android build/install needs JDK 17 and adb."
    if ask_yes_no "Install Android-related distro packages now?" y; then
      install_packages "$(detect_pm)" 1
    fi
  fi
  npm --prefix "$root/mobile/dexydMobile" install
  (cd "$root/mobile/dexydMobile/android" && ./gradlew assembleDebug)
  ok "Android debug APK built"
}

main() {
  bold "Dexyd installer"
  dim "Repository: $REPO_URL"
  dim "Branch:     $BRANCH"
  dim "Install to: $INSTALL_DIR"

  check_core_dependencies
  local root
  root="$(resolve_repo_root)"
  cd "$root"

  write_config "$root"

  bold "Installing bridge dependencies"
  npm install

  if ask_yes_no "Install TUI Python dependencies now?" y; then
    install_tui_deps "$root"
  fi

  bold "Building bridge"
  npm run build

  build_android_if_requested "$root"
  install_command "$root"

  if [[ "$INSTALL_SERVICE" == "1" ]] || ask_yes_no "Install and start Dexyd as a user service?" y; then
    install_user_service "$root"
  fi

  if [[ "$OPEN_FIREWALL" == "1" ]] || ask_yes_no "Open bridge port 4242 in the local firewall if supported?" n; then
    open_bridge_firewall 4242 || true
  fi

  bold "Dexyd installed"
  printf '\nNext steps:\n'
  printf '  dexyd --tui          # open setup/pairing UI\n'
  printf '  dexyd                # start bridge in foreground\n'
  printf '  systemctl --user status dexyd.service\n'
  printf '\nGenerate a pairing QR in the TUI, then scan it from the mobile app.\n'
}

main "$@"
