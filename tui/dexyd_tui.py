#!/usr/bin/env python3
from __future__ import annotations

import base64
import copy
import datetime as dt
import json
import os
import platform
import re
import secrets
import selectors
import shlex
import shutil
import socket
import subprocess
import sqlite3
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib import error, request
from urllib.parse import urlencode, urlparse

import qrcode
import yaml
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Footer, Header, Input, Static, TabbedContent, TabPane

DEFAULT_CONFIG: dict[str, Any] = {
    "server": {"host": "0.0.0.0", "port": 4242, "logLevel": "info", "publicBaseUrl": ""},
    "storage": {"dataDir": ".dexyd", "sqlitePath": ".dexyd/dexyd.db"},
    "auth": {
        "accessTokenTtlSeconds": 900,
        "refreshTokenTtlSeconds": 2592000,
        "signingKey": secrets.token_urlsafe(48),
    },
    "stream": {
        "replayWindowSeconds": 600,
        "heartbeatActiveSeconds": 20,
        "heartbeatIdleSeconds": 50,
        "maxReplayEvents": 500,
        "maxQueuedEventsPerClient": 1000,
        "maxBufferedBytes": 1024 * 1024,
    },
    "codex": {
        "runtimePath": "codex",
        "workspaceRoot": str(Path.cwd()),
        "permissionMode": "bypass",
        "harness": {"mode": "direct", "command": "omx", "args": []},
    },
    "opencode": {
        "enabled": True,
        "runtimePath": "opencode",
        "dataDir": str(Path.home() / ".local" / "share" / "opencode"),
        "permissionMode": "bypass",
        "server": {
            "autoStart": True,
            "host": "127.0.0.1",
            "port": 4243,
            "startTimeoutMs": 15000,
            "healthTimeoutMs": 4000,
            "password": "",
            "cors": [],
            "mdns": False,
            "mdnsDomain": "opencode.local",
            "extraArgs": [],
        },
        "defaultAgent": "build",
        "defaultModel": "",
        "eventStreamEnabled": True,
        "streamReconnectMs": 2000,
        "streamIdleTimeoutMs": 0,
    },
    "assistant": {"mode": "codex"},
    "plugins": {"enabled": True, "pluginDir": ".dexyd/plugins"},
    "cloudflare": {"hostname": "", "tunnelName": "dexyd"},
}

LOG_LEVELS = {"fatal", "error", "warn", "info", "debug", "trace"}
HARNESS_MODES = {"direct", "omx", "custom"}
ASSISTANT_MODES = {"codex", "opencode"}
PERMISSION_MODES = {"inherit", "read-only", "workspace-write", "danger-full-access", "bypass"}
DEXYD_DATA_DIR = Path(
    os.environ.get("DEXYD_DATA_DIR")
    or (
        Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))
        / "dexyd"
    )
)
CLOUDFLARE_LOG_DIR = DEXYD_DATA_DIR / ".dexyd" / "cloudflared"
CLOUDFLARE_PID_FILE = CLOUDFLARE_LOG_DIR / "cloudflared.pid"
CLOUDFLARE_LOG_FILE = CLOUDFLARE_LOG_DIR / "cloudflared.log"
CLOUDFLARE_CONFIG_FILE = CLOUDFLARE_LOG_DIR / "config.yml"
CLOUDFLARE_METADATA_FILE = CLOUDFLARE_LOG_DIR / "tunnel.json"
CLOUDFLARE_MAX_NAME_ATTEMPTS = 50
UUID_RE = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
HOSTNAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")
DEXYD_REPO_URL = "https://github.com/DrB0rk/dexyd.git"
DEXYD_REPO_RELEASE_API = "https://api.github.com/repos/DrB0rk/dexyd/releases/latest"
DEXYD_INSTALLER_URL = "https://raw.githubusercontent.com/DrB0rk/dexyd/main/scripts/install.sh"
DEXYD_RELEASES_URL = "https://github.com/DrB0rk/dexyd/releases/latest"


@dataclass
class ConfigStore:
    path: Path
    format: str
    editable: bool
    config: dict[str, Any]


@dataclass
class DeviceRecord:
    id: str
    label: str
    last_seen_at: str | None
    trust_state: str
    created_at: str


@dataclass
class SessionRecord:
    id: str
    status: str
    profile: str
    workspace_path: str
    updated_at: str
    title: str | None = None
    source: str = "dexyd"
    created_at: str | None = None
    model: str | None = None
    agent: str | None = None


@dataclass
class CloudflareTunnelSetup:
    tunnel_id: str
    tunnel_name: str
    hostname: str
    public_url: str
    config_path: Path
    route_output: str = ""
    reused_existing: bool = False


class CloudflareDuplicateError(RuntimeError):
    def __init__(self, message: str, *, conflict: str, tunnel_name: str, hostname: str) -> None:
        super().__init__(message)
        self.conflict = conflict
        self.tunnel_name = tunnel_name
        self.hostname = hostname


@dataclass
class UpdateInfo:
    current_version: str
    latest_version: str
    release_name: str
    release_url: str
    apk_name: str | None
    apk_url: str | None
    update_available: bool


@dataclass
class InstalledRuntimeInfo:
    running_root: Path
    running_version: str
    installed_command: Path | None
    installed_target: Path | None
    installed_root: Path | None
    installed_version: str
    command_matches_running_root: bool


def app_root() -> Path:
    return Path.cwd().resolve()


def default_install_dir() -> Path:
    data_home = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))
    return (data_home / "dexyd").resolve()


def installed_command_target() -> Path | None:
    command = Path.home() / ".local" / "bin" / "dexyd"
    try:
        return command.resolve(strict=True)
    except OSError:
        return None


def installed_runtime_info(root: Path | None = None) -> InstalledRuntimeInfo:
    running_root = (root or app_root()).resolve()
    command = Path.home() / ".local" / "bin" / "dexyd"
    command_target = installed_command_target()
    installed_root = command_target.parent.parent.resolve(strict=False) if command_target else None
    return InstalledRuntimeInfo(
        running_root=running_root,
        running_version=read_package_version(running_root),
        installed_command=command if command.exists() else None,
        installed_target=command_target,
        installed_root=installed_root,
        installed_version=read_package_version(installed_root) if installed_root else "not installed",
        command_matches_running_root=command_target == (running_root / "bin" / "dexyd").resolve(strict=False),
    )


def read_package_version(root: Path | None = None) -> str:
    package_json = (root or app_root()) / "package.json"
    try:
        data = json.loads(package_json.read_text(encoding="utf-8"))
        return str(data.get("version") or "0.0.0")
    except (OSError, json.JSONDecodeError):
        return "0.0.0"


def normalize_version(value: str) -> list[int]:
    core = str(value or "0.0.0").strip().removeprefix("v").split("-", 1)[0]
    parts: list[int] = []
    for part in core.split("."):
        try:
            parts.append(int(part))
        except ValueError:
            parts.append(0)
    while len(parts) < 3:
        parts.append(0)
    return parts[:3]


def version_is_newer(latest: str, current: str) -> bool:
    return normalize_version(latest) > normalize_version(current)


def latest_release_info() -> UpdateInfo:
    req = request.Request(DEXYD_REPO_RELEASE_API, headers={"Accept": "application/vnd.github+json"})
    with request.urlopen(req, timeout=20) as response:
        release = json.loads(response.read().decode("utf-8"))

    latest = str(release.get("tag_name") or "").strip()
    if not latest:
        raise RuntimeError("GitHub latest release has no tag.")

    apk_name: str | None = None
    apk_url: str | None = None
    for asset in release.get("assets") or []:
        if not isinstance(asset, dict):
            continue
        name = str(asset.get("name") or "")
        url = str(asset.get("browser_download_url") or "")
        if name.lower().endswith(".apk") and url.startswith("https://github.com/"):
            apk_name = name
            apk_url = url
            break

    current = read_package_version()
    return UpdateInfo(
        current_version=current,
        latest_version=latest,
        release_name=str(release.get("name") or latest),
        release_url=str(release.get("html_url") or DEXYD_RELEASES_URL),
        apk_name=apk_name,
        apk_url=apk_url,
        update_available=version_is_newer(latest, current),
    )


def format_update_info(info: UpdateInfo | None, busy: bool = False, log: str = "", relaunch_pending: bool = False) -> str:
    runtime = installed_runtime_info()
    if info is None:
        lines = [
            "UPDATES",
            "",
            f"Running TUI version:  {runtime.running_version}",
            f"Installed command:    {runtime.installed_command or 'missing'}",
            f"Installed target:     {runtime.installed_target or 'missing'}",
            f"Installed version:    {runtime.installed_version}",
            f"Running from install: {'yes' if runtime.command_matches_running_root else 'no'}",
            "Latest release: not checked",
            "",
            "Use Check updates to query GitHub Releases.",
        ]
    else:
        lines = [
            "UPDATES",
            "",
            f"Running TUI version:  {runtime.running_version}",
            f"Installed command:    {runtime.installed_command or 'missing'}",
            f"Installed target:     {runtime.installed_target or 'missing'}",
            f"Installed version:    {runtime.installed_version}",
            f"Running from install: {'yes' if runtime.command_matches_running_root else 'no'}",
            f"Latest release:      {info.latest_version}",
            f"Status:              {'update available' if info.update_available else 'up to date'}",
            f"Release:             {info.release_url}",
            f"Android APK:         {info.apk_name or 'not attached'}",
        ]
        if info.apk_url:
            lines.append(f"APK URL:             {info.apk_url}")
        lines.extend(
            [
                "",
                "Install / repair bridge reruns the official installer for the latest release, preserving dexyd.config.yaml and .dexyd data.",
                "After a successful install, this TUI relaunches through ~/.local/bin/dexyd so you land in the updated version automatically.",
                "The Android app updates from Settings → Updates on the phone; Android will ask before installing APKs.",
            ]
        )
    if busy:
        lines.extend(["", "TASK STATUS", "", "● Update task is running. Leave this TUI open; installer output streams below."])
    if relaunch_pending:
        lines.extend(["", "RELAUNCH", "", "● Update installed. Relaunching the TUI through the installed dexyd command…"])
    if log.strip():
        lines.extend(["", "RECENT ACTIVITY", "", log.strip()])
    return "\n".join(lines)


def safe_update_root(root: Path) -> tuple[bool, str]:
    expected_command = root / "bin" / "dexyd"
    command_target = installed_command_target()
    if root == default_install_dir():
        return True, "default install directory"
    if command_target == expected_command.resolve(strict=False):
        return True, "installed dexyd command points here"
    if (root / ".git").exists():
        return False, "Refusing to update a development checkout from the TUI. Use git pull/merge and the release workflow instead."
    return True, "non-git app directory"


def download_installer_script(target: Path) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    req = request.Request(DEXYD_INSTALLER_URL, headers={"User-Agent": "Dexyd TUI updater"})
    with request.urlopen(req, timeout=30) as response:
        data = response.read()
    if not data.startswith(b"#!/usr/bin/env bash"):
        raise RuntimeError("Downloaded installer did not look like the official Dexyd installer.")
    target.write_bytes(data)
    target.chmod(0o755)
    return target


def update_branch_name(info: UpdateInfo | None) -> str:
    candidate = str(info.latest_version if info else "main").strip()
    if re.match(r"^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$", candidate):
        return candidate if candidate.startswith("v") else f"v{candidate}"
    return "main"


def sanitized_update_env(root: Path) -> dict[str, str]:
    env = dict(os.environ)
    venv_bin = str(root / ".dexyd" / ".venv-tui" / "bin")
    path_parts = [part for part in env.get("PATH", "").split(os.pathsep) if part and part != venv_bin]
    for fallback in ("/usr/local/bin", "/usr/bin", "/bin"):
        if fallback not in path_parts:
            path_parts.append(fallback)
    env.update(
        {
            "DEXYD_INSTALL_DIR": str(root),
            "PIP_DISABLE_PIP_VERSION_CHECK": "1",
            "PIP_NO_CACHE_DIR": "1",
        }
    )
    env["PATH"] = os.pathsep.join(path_parts)
    for key in ("VIRTUAL_ENV", "PYTHONHOME", "PYTHONPATH"):
        env.pop(key, None)
    return env


def run_update_installer(
    command: list[str],
    env: dict[str, str],
    log: Callable[[str], None] | None = None,
    timeout: int = 900,
    cwd: Path | None = None,
) -> tuple[int, str]:
    output_lines: list[str] = []
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        text=True,
        env=env,
        cwd=str(cwd or Path.home()),
        bufsize=1,
    )
    deadline = time.time() + timeout
    assert process.stdout is not None
    try:
        for line in process.stdout:
            cleaned = line.rstrip()
            if cleaned:
                output_lines.append(cleaned)
                if len(output_lines) > 500:
                    output_lines = output_lines[-500:]
                if log:
                    log(cleaned)
            if time.time() > deadline:
                process.kill()
                raise TimeoutError("Installer timed out.")
        return process.wait(timeout=10), "\n".join(output_lines)
    finally:
        try:
            process.stdout.close()
        except Exception:
            pass


def verify_update_result(root: Path, target_version: str) -> str:
    installed_version = read_package_version(root)
    command_target = installed_command_target()
    expected_command = (root / "bin" / "dexyd").resolve(strict=False)
    if command_target != expected_command:
        raise RuntimeError(
            f"Update finished, but ~/.local/bin/dexyd points to {command_target or 'nothing'} instead of {expected_command}."
        )
    if version_is_newer(target_version, installed_version):
        raise RuntimeError(f"Update finished, but installed version is still {installed_version}; expected {target_version}.")
    return installed_version


def relaunch_installed_tui(config_path: Path | None = None) -> None:
    command = installed_command_target()
    if not command or not executable_at(command):
        raise RuntimeError("Cannot relaunch: ~/.local/bin/dexyd is missing or not executable.")
    args = [str(command), "--tui"]
    if config_path:
        args.append(str(config_path))
    os.execv(str(command), args)


def install_latest_bridge_update(
    root: Path,
    info: UpdateInfo | None = None,
    log: Callable[[str], None] | None = None,
) -> str:
    ok, reason = safe_update_root(root)
    if not ok:
        raise RuntimeError(reason)

    branch = update_branch_name(info)
    target_version = (info.latest_version if info else branch).removeprefix("v")
    temp_dir = Path(tempfile.mkdtemp(prefix="dexyd-update-"))
    try:
        installer = download_installer_script(temp_dir / "install.sh")
        command = [
            "bash",
            str(installer),
            "--repo",
            DEXYD_REPO_URL,
            "--branch",
            branch,
            "--dir",
            str(root),
        ]
        if log:
            log(f"Running installer from {temp_dir} for {branch} into {root}")
        returncode, output = run_update_installer(command, sanitized_update_env(root), log=log, cwd=temp_dir)
        if returncode != 0:
            raise RuntimeError(f"Installer failed with exit {returncode}:\n{output[-4000:]}")
        installed_version = verify_update_result(root, target_version)
        return (
            f"Bridge/TUI install repaired at {root} ({reason}). Installed version: {installed_version}. "
            "Relaunching this TUI through ~/.local/bin/dexyd to load updated code."
        )
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def parse_int(value: Any, fallback: int, minimum: int = 1) -> int:
    try:
        parsed = int(value)
        if parsed >= minimum:
            return parsed
    except (TypeError, ValueError):
        pass
    return fallback


def parse_bool(value: Any, fallback: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on", "enabled"}:
            return True
        if normalized in {"0", "false", "no", "off", "disabled"}:
            return False
    return fallback


def normalize_assistant_mode(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("mode") or value.get("defaultMode")
    mode = str(value or "").strip().lower()
    if mode in {"omx", "direct", "custom"}:
        return "codex"
    return mode if mode in ASSISTANT_MODES else DEFAULT_CONFIG["assistant"]["mode"]


def normalize_public_base_url(value: Any) -> str:
    url = str(value or "").strip().rstrip("/")
    if not url:
        return ""

    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""

    return url


def normalize_cloudflare_hostname(value: Any) -> str:
    raw = str(value or "").strip().lower().rstrip("/")
    if not raw:
        return ""

    parsed = urlparse(raw if "://" in raw else f"https://{raw}")
    hostname = (parsed.hostname or "").strip().lower().rstrip(".")
    if not hostname or not HOSTNAME_RE.match(hostname):
        return ""

    return hostname


def cloudflare_public_url(value: Any) -> str:
    hostname = normalize_cloudflare_hostname(value)
    return f"https://{hostname}" if hostname else ""


def normalize_config(config: dict[str, Any]) -> dict[str, Any]:
    merged = deep_merge(DEFAULT_CONFIG, config)

    merged["server"]["host"] = str(merged["server"].get("host") or DEFAULT_CONFIG["server"]["host"])
    merged["server"]["port"] = parse_int(merged["server"].get("port"), DEFAULT_CONFIG["server"]["port"], 1)

    log_level = str(merged["server"].get("logLevel") or DEFAULT_CONFIG["server"]["logLevel"]).lower()
    merged["server"]["logLevel"] = log_level if log_level in LOG_LEVELS else DEFAULT_CONFIG["server"]["logLevel"]
    merged["server"]["publicBaseUrl"] = normalize_public_base_url(merged["server"].get("publicBaseUrl"))

    merged["auth"]["accessTokenTtlSeconds"] = parse_int(
        merged["auth"].get("accessTokenTtlSeconds"), DEFAULT_CONFIG["auth"]["accessTokenTtlSeconds"], 30
    )
    merged["auth"]["refreshTokenTtlSeconds"] = parse_int(
        merged["auth"].get("refreshTokenTtlSeconds"), DEFAULT_CONFIG["auth"]["refreshTokenTtlSeconds"], 60
    )
    merged["auth"]["signingKey"] = str(merged["auth"].get("signingKey") or DEFAULT_CONFIG["auth"]["signingKey"])

    merged["stream"]["replayWindowSeconds"] = parse_int(
        merged["stream"].get("replayWindowSeconds"), DEFAULT_CONFIG["stream"]["replayWindowSeconds"], 10
    )
    merged["stream"]["heartbeatIdleSeconds"] = parse_int(
        merged["stream"].get("heartbeatIdleSeconds"), DEFAULT_CONFIG["stream"]["heartbeatIdleSeconds"], 5
    )
    merged["storage"]["sqlitePath"] = str(merged["storage"].get("sqlitePath") or DEFAULT_CONFIG["storage"]["sqlitePath"])
    merged["codex"]["runtimePath"] = str(merged["codex"].get("runtimePath") or DEFAULT_CONFIG["codex"]["runtimePath"])
    merged["codex"]["workspaceRoot"] = str(merged["codex"].get("workspaceRoot") or DEFAULT_CONFIG["codex"]["workspaceRoot"])
    permission_mode = str(merged["codex"].get("permissionMode") or DEFAULT_CONFIG["codex"]["permissionMode"]).strip()
    merged["codex"]["permissionMode"] = permission_mode if permission_mode in PERMISSION_MODES else DEFAULT_CONFIG["codex"]["permissionMode"]
    harness = merged["codex"].get("harness")
    if not isinstance(harness, dict):
        harness = copy.deepcopy(DEFAULT_CONFIG["codex"]["harness"])
    mode = str(harness.get("mode") or DEFAULT_CONFIG["codex"]["harness"]["mode"]).strip().lower()
    harness["mode"] = mode if mode in HARNESS_MODES else DEFAULT_CONFIG["codex"]["harness"]["mode"]
    harness["command"] = str(harness.get("command") or DEFAULT_CONFIG["codex"]["harness"]["command"]).strip()
    args = harness.get("args")
    harness["args"] = [str(arg) for arg in args if "\0" not in str(arg)] if isinstance(args, list) else []
    merged["codex"]["harness"] = harness

    opencode = merged.get("opencode")
    if not isinstance(opencode, dict):
        opencode = copy.deepcopy(DEFAULT_CONFIG["opencode"])
    opencode["enabled"] = parse_bool(opencode.get("enabled"), DEFAULT_CONFIG["opencode"]["enabled"])
    opencode["runtimePath"] = str(opencode.get("runtimePath") or DEFAULT_CONFIG["opencode"]["runtimePath"]).strip() or DEFAULT_CONFIG["opencode"]["runtimePath"]
    opencode["dataDir"] = str(opencode.get("dataDir") or DEFAULT_CONFIG["opencode"]["dataDir"]).strip() or DEFAULT_CONFIG["opencode"]["dataDir"]
    opencode["permissionMode"] = str(opencode.get("permissionMode") or DEFAULT_CONFIG["opencode"]["permissionMode"]).strip()
    if opencode["permissionMode"] not in PERMISSION_MODES:
        opencode["permissionMode"] = DEFAULT_CONFIG["opencode"]["permissionMode"]
    server = opencode.get("server")
    if not isinstance(server, dict):
        server = copy.deepcopy(DEFAULT_CONFIG["opencode"]["server"])
    server["autoStart"] = parse_bool(server.get("autoStart"), DEFAULT_CONFIG["opencode"]["server"]["autoStart"])
    server["host"] = str(server.get("host") or DEFAULT_CONFIG["opencode"]["server"]["host"]).strip() or DEFAULT_CONFIG["opencode"]["server"]["host"]
    server["port"] = parse_int(server.get("port"), DEFAULT_CONFIG["opencode"]["server"]["port"], 1)
    server["startTimeoutMs"] = parse_int(server.get("startTimeoutMs"), DEFAULT_CONFIG["opencode"]["server"]["startTimeoutMs"], 1000)
    server["healthTimeoutMs"] = parse_int(server.get("healthTimeoutMs"), DEFAULT_CONFIG["opencode"]["server"]["healthTimeoutMs"], 500)
    server["password"] = str(server.get("password") or "")
    cors = server.get("cors")
    server["cors"] = [str(item).strip() for item in cors if str(item).strip()] if isinstance(cors, list) else []
    server["mdns"] = parse_bool(server.get("mdns"), DEFAULT_CONFIG["opencode"]["server"]["mdns"])
    server["mdnsDomain"] = str(server.get("mdnsDomain") or DEFAULT_CONFIG["opencode"]["server"]["mdnsDomain"]).strip() or DEFAULT_CONFIG["opencode"]["server"]["mdnsDomain"]
    extra_args = server.get("extraArgs")
    server["extraArgs"] = [str(arg) for arg in extra_args if "\0" not in str(arg)] if isinstance(extra_args, list) else []
    opencode["server"] = server
    opencode["defaultAgent"] = str(opencode.get("defaultAgent") or DEFAULT_CONFIG["opencode"]["defaultAgent"]).strip() or DEFAULT_CONFIG["opencode"]["defaultAgent"]
    opencode["defaultModel"] = str(opencode.get("defaultModel") or "")
    opencode["eventStreamEnabled"] = parse_bool(opencode.get("eventStreamEnabled"), DEFAULT_CONFIG["opencode"]["eventStreamEnabled"])
    opencode["streamReconnectMs"] = parse_int(opencode.get("streamReconnectMs"), DEFAULT_CONFIG["opencode"]["streamReconnectMs"], 250)
    opencode["streamIdleTimeoutMs"] = max(0, parse_int(opencode.get("streamIdleTimeoutMs"), DEFAULT_CONFIG["opencode"]["streamIdleTimeoutMs"] or 1, 1) if opencode.get("streamIdleTimeoutMs") else 0)
    merged["opencode"] = opencode

    assistant = merged.get("assistant")
    if not isinstance(assistant, dict):
        assistant = copy.deepcopy(DEFAULT_CONFIG["assistant"])
    assistant["mode"] = normalize_assistant_mode(assistant)
    assistant["defaultMode"] = assistant["mode"]
    merged["assistant"] = assistant

    cloudflare = merged.get("cloudflare")
    if not isinstance(cloudflare, dict):
        cloudflare = copy.deepcopy(DEFAULT_CONFIG["cloudflare"])
    cloudflare["hostname"] = normalize_cloudflare_hostname(cloudflare.get("hostname"))
    cloudflare["tunnelName"] = normalized_tunnel_name(cloudflare.get("tunnelName") or DEFAULT_CONFIG["cloudflare"]["tunnelName"])
    merged["cloudflare"] = cloudflare

    return merged


def run_capture(command: list[str], timeout: int = 30, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=False, capture_output=True, text=True, timeout=timeout, env=env)


def executable_at(path: Path) -> bool:
    return path.exists() and os.access(path, os.X_OK)


def cloudflared_path() -> str | None:
    found = shutil.which("cloudflared")
    if found:
        return found

    local = Path.home() / ".local" / "bin" / "cloudflared"
    return str(local) if executable_at(local) else None


def cloudflared_download_url() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "linux":
        if machine in {"x86_64", "amd64"}:
            return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
        if machine in {"aarch64", "arm64"}:
            return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
        if machine.startswith("arm"):
            return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm"

    raise RuntimeError(f"Automatic user-local cloudflared install is only implemented for Linux, not {system}/{machine}.")


def install_cloudflared_user_local() -> str:
    existing = cloudflared_path()
    if existing:
        return existing

    target_dir = Path.home() / ".local" / "bin"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / "cloudflared"
    temp = target.with_suffix(".download")

    url = cloudflared_download_url()
    with request.urlopen(url, timeout=120) as response:
        temp.write_bytes(response.read())
    temp.chmod(0o755)
    temp.replace(target)
    return str(target)


def cloudflared_version(path: str) -> str:
    result = run_capture([path, "--version"], timeout=10)
    output = (result.stdout or result.stderr).strip()
    return output or "installed"


def cloudflared_cert_path() -> Path:
    return Path.home() / ".cloudflared" / "cert.pem"


def read_pid(path: Path) -> int | None:
    try:
        return int(path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None


def process_is_running(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def clear_cloudflare_pid() -> None:
    try:
        CLOUDFLARE_PID_FILE.unlink()
    except FileNotFoundError:
        pass


def stop_pid(pid: int | None) -> bool:
    if not process_is_running(pid):
        clear_cloudflare_pid()
        return False
    try:
        os.kill(int(pid), 15)
    except OSError:
        clear_cloudflare_pid()
        return False

    deadline = time.time() + 5
    while time.time() < deadline:
        if not process_is_running(pid):
            clear_cloudflare_pid()
            return True
        time.sleep(0.2)

    try:
        os.kill(int(pid), 9)
    except OSError:
        clear_cloudflare_pid()
        return False

    deadline = time.time() + 2
    while time.time() < deadline:
        if not process_is_running(pid):
            clear_cloudflare_pid()
            return True
        time.sleep(0.2)

    return False


def cloudflare_status_text(config: dict[str, Any]) -> str:
    path = cloudflared_path()
    pid = read_pid(CLOUDFLARE_PID_FILE)
    running = process_is_running(pid)
    local_url = f"http://127.0.0.1:{config['server']['port']}"
    public_url = config["server"].get("publicBaseUrl") or "(not configured)"
    metadata = read_cloudflare_metadata()
    configured = CLOUDFLARE_CONFIG_FILE.exists()

    lines = [
        "CLOUDFLARE",
        "",
        f"{'●' if path else '○'} cloudflared: {'installed' if path else 'missing'}{f' ({path})' if path else ''}",
    ]
    if path:
        lines.append(f"version: {cloudflared_version(path)}")
    lines.extend(
        [
            f"{'●' if cloudflared_cert_path().exists() else '○'} login: {'present' if cloudflared_cert_path().exists() else 'missing'}",
            f"{'●' if configured else '○'} config: {'present' if configured else 'missing'}",
            f"{'●' if running else '○'} tunnel process: {'running' if running else 'stopped'}{f' (pid {pid})' if running else ''}",
            f"origin: {local_url}",
            f"public: {public_url}",
            f"name: {metadata.get('tunnelName') or config.get('cloudflare', {}).get('tunnelName') or 'dexyd'}",
            f"hostname: {metadata.get('hostname') or config.get('cloudflare', {}).get('hostname') or '(not configured)'}",
            f"log: {CLOUDFLARE_LOG_FILE}",
        ]
    )
    return "\n".join(lines)


def local_cloudflare_origin(config: dict[str, Any]) -> str:
    return f"http://127.0.0.1:{config['server']['port']}"


def start_cloudflared_process(command: list[str], env: dict[str, str] | None = None) -> int:
    CLOUDFLARE_LOG_DIR.mkdir(parents=True, exist_ok=True)
    log = CLOUDFLARE_LOG_FILE.open("a", encoding="utf-8")
    log.write(f"\n\n--- cloudflared start at {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
    log.flush()
    try:
        process = subprocess.Popen(
            command,
            stdout=log,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            env=env,
            start_new_session=True,
        )
    finally:
        log.close()
    CLOUDFLARE_PID_FILE.write_text(str(process.pid), encoding="utf-8")
    return process.pid


def list_cloudflare_tunnels(path: str) -> list[dict[str, Any]]:
    result = run_capture([path, "tunnel", "list", "--output", "json"], timeout=30)
    if result.returncode != 0:
        return []
    try:
        parsed = json.loads(result.stdout or "[]")
        return parsed if isinstance(parsed, list) else []
    except json.JSONDecodeError:
        return []


def normalized_tunnel_name(value: Any) -> str:
    name = str(value or "").strip()
    name = re.sub(r"[^A-Za-z0-9_.-]+", "-", name).strip(".-_")
    return name or "dexyd"


def numbered_name(base: str, attempt: int, max_length: int | None = None) -> str:
    base = base.strip() or "dexyd"
    if attempt <= 1:
        return base[:max_length] if max_length else base

    suffix = f"-{attempt}"
    if max_length is not None:
        trimmed = base[: max(1, max_length - len(suffix))].rstrip("-")
        return f"{trimmed or 'dexyd'}{suffix}"
    return f"{base}{suffix}"


def numbered_hostname(hostname: str, attempt: int) -> str:
    hostname = normalize_cloudflare_hostname(hostname)
    if not hostname:
        return ""
    labels = hostname.split(".")
    labels[0] = numbered_name(labels[0], attempt, max_length=63)
    return ".".join(labels)


def tunnel_index_by_name(tunnels: list[dict[str, Any]]) -> dict[str, str]:
    indexed: dict[str, str] = {}
    for tunnel in tunnels:
        tunnel_name = str(tunnel.get("name") or "")
        tunnel_id = str(tunnel.get("id") or tunnel.get("uuid") or "")
        if tunnel_name and tunnel_id:
            indexed[tunnel_name] = tunnel_id
    return indexed


def command_output(result: subprocess.CompletedProcess[str]) -> str:
    return f"{result.stdout}\n{result.stderr}".strip()


def output_mentions_existing_resource(output: str) -> bool:
    lowered = output.lower()
    return any(
        text in lowered
        for text in (
            "already exists",
            "record already exists",
            "hostname already exists",
            "cname record with that host already exists",
            "a, aaaa, or cname record with that host already exists",
        )
    )


def read_cloudflare_metadata() -> dict[str, Any]:
    try:
        parsed = json.loads(CLOUDFLARE_METADATA_FILE.read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def write_cloudflare_metadata(setup: CloudflareTunnelSetup, requested_name: str, requested_hostname: str, origin_url: str) -> None:
    CLOUDFLARE_LOG_DIR.mkdir(parents=True, exist_ok=True)
    metadata = {
        "managedBy": "dexyd",
        "tunnelId": setup.tunnel_id,
        "tunnelName": setup.tunnel_name,
        "hostname": setup.hostname,
        "publicUrl": setup.public_url,
        "originUrl": origin_url,
        "requestedTunnelName": requested_name,
        "requestedHostname": requested_hostname,
        "configFile": str(setup.config_path),
        "credentialsFile": str(cloudflare_credentials_file(setup.tunnel_id)),
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    CLOUDFLARE_METADATA_FILE.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")


def cloudflare_credentials_file(tunnel_id: str) -> Path:
    return Path.home() / ".cloudflared" / f"{tunnel_id}.json"


def managed_tunnel_matches(tunnel_name: str, _hostname: str, tunnel_id: str | None = None) -> bool:
    metadata = read_cloudflare_metadata()
    if not metadata:
        return False
    managed_by = str(metadata.get("managedBy") or "")
    if managed_by and managed_by != "dexyd":
        return False
    names = {str(metadata.get("tunnelName") or ""), str(metadata.get("requestedTunnelName") or "")}
    if tunnel_name not in names:
        return False
    if tunnel_id is not None and str(metadata.get("tunnelId") or "") != tunnel_id:
        return False
    return True


def credentials_file_ready(tunnel_id: str) -> bool:
    credentials_file = cloudflare_credentials_file(tunnel_id)
    return credentials_file.exists() and credentials_file.is_file()


def create_named_tunnel(path: str, name: str) -> str:
    created = run_capture([path, "tunnel", "create", name], timeout=60)
    output = command_output(created)
    if created.returncode != 0:
        raise RuntimeError(f"Could not create Cloudflare tunnel {name!r}: {output}")

    match = UUID_RE.search(output)
    if match:
        return match.group(0)

    for tunnel in list_cloudflare_tunnels(path):
        tunnel_name = str(tunnel.get("name") or "")
        tunnel_id = str(tunnel.get("id") or tunnel.get("uuid") or "")
        if tunnel_name == name and tunnel_id:
            return tunnel_id

    raise RuntimeError(f"Cloudflare tunnel {name!r} was created, but its UUID could not be determined.")


def delete_cloudflare_tunnel(path: str, tunnel_id_or_name: str) -> None:
    if not tunnel_id_or_name:
        return
    run_capture([path, "tunnel", "delete", "-f", tunnel_id_or_name], timeout=60)


def ensure_named_tunnel(path: str, name: str) -> str:
    for tunnel in list_cloudflare_tunnels(path):
        tunnel_name = str(tunnel.get("name") or "")
        tunnel_id = str(tunnel.get("id") or tunnel.get("uuid") or "")
        if tunnel_name == name and tunnel_id:
            return tunnel_id

    created = run_capture([path, "tunnel", "create", name], timeout=60)
    output = f"{created.stdout}\n{created.stderr}"
    if created.returncode != 0 and "already exists" not in output.lower():
        raise RuntimeError(f"Could not create Cloudflare tunnel: {output.strip()}")

    match = UUID_RE.search(output)
    if match:
        return match.group(0)

    for tunnel in list_cloudflare_tunnels(path):
        tunnel_name = str(tunnel.get("name") or "")
        tunnel_id = str(tunnel.get("id") or tunnel.get("uuid") or "")
        if tunnel_name == name and tunnel_id:
            return tunnel_id

    raise RuntimeError("Cloudflare tunnel was created/found, but its UUID could not be determined.")


def ensure_available_cloudflare_tunnel(
    path: str,
    requested_name: str,
    requested_hostname: str,
    origin_url: str,
    *,
    overwrite: bool = False,
) -> CloudflareTunnelSetup:
    tunnel_name = normalized_tunnel_name(requested_name)
    hostname = normalize_cloudflare_hostname(requested_hostname)
    if not hostname:
        raise RuntimeError("Enter a Cloudflare-managed public hostname, e.g. dexyd.example.com")

    tunnels = tunnel_index_by_name(list_cloudflare_tunnels(path))
    existing_tunnel_id = tunnels.get(tunnel_name)
    created_tunnel_id: str | None = None
    reused_existing = False

    if existing_tunnel_id:
        if managed_tunnel_matches(tunnel_name, hostname, existing_tunnel_id) and credentials_file_ready(existing_tunnel_id):
            tunnel_id = existing_tunnel_id
            reused_existing = True
        elif overwrite:
            delete_cloudflare_tunnel(path, existing_tunnel_id)
            tunnel_id = create_named_tunnel(path, tunnel_name)
            created_tunnel_id = tunnel_id
        else:
            raise CloudflareDuplicateError(
                f"Cloudflare tunnel name {tunnel_name!r} already exists and is not the saved Dexyd tunnel. "
                "Choose a different name or confirm overwrite.",
                conflict="name",
                tunnel_name=tunnel_name,
                hostname=hostname,
            )
    else:
        try:
            tunnel_id = create_named_tunnel(path, tunnel_name)
            created_tunnel_id = tunnel_id
        except RuntimeError as exc:
            if overwrite and output_mentions_existing_resource(str(exc)):
                delete_cloudflare_tunnel(path, tunnel_name)
                tunnel_id = create_named_tunnel(path, tunnel_name)
                created_tunnel_id = tunnel_id
            elif output_mentions_existing_resource(str(exc)):
                raise CloudflareDuplicateError(
                    f"Cloudflare tunnel name {tunnel_name!r} already exists. Choose a different name or confirm overwrite.",
                    conflict="name",
                    tunnel_name=tunnel_name,
                    hostname=hostname,
                ) from exc
            else:
                raise

    route_command = [path, "tunnel", "route", "dns"]
    if overwrite:
        route_command.append("--overwrite-dns")
    route_command.extend([tunnel_name, hostname])
    route = run_capture(route_command, timeout=60)
    route_output = command_output(route)
    if route.returncode != 0:
        if created_tunnel_id:
            delete_cloudflare_tunnel(path, created_tunnel_id)
        if output_mentions_existing_resource(route_output):
            raise CloudflareDuplicateError(
                f"Cloudflare hostname {hostname!r} already has a DNS record. "
                "Choose a different hostname or confirm overwrite.",
                conflict="hostname",
                tunnel_name=tunnel_name,
                hostname=hostname,
            )
        raise RuntimeError(f"Could not create Cloudflare DNS route for {hostname}: {route_output}")

    if not credentials_file_ready(tunnel_id):
        if created_tunnel_id:
            delete_cloudflare_tunnel(path, created_tunnel_id)
        raise RuntimeError(
            f"Cloudflare tunnel {tunnel_name!r} is missing credentials: {cloudflare_credentials_file(tunnel_id)}"
        )

    config_path = write_cloudflare_config(tunnel_id, tunnel_name, hostname, origin_url)
    setup = CloudflareTunnelSetup(
        tunnel_id=tunnel_id,
        tunnel_name=tunnel_name,
        hostname=hostname,
        public_url=f"https://{hostname}",
        config_path=config_path,
        route_output=route_output,
        reused_existing=reused_existing,
    )
    write_cloudflare_metadata(setup, tunnel_name, hostname, origin_url)
    return setup


def ensure_bridge_origin_ready(config: dict[str, Any]) -> None:
    origin = local_cloudflare_origin(config)
    health, detail = get_bridge_health(origin)
    if health not in {"ready", "ok"}:
        raise RuntimeError(f"Bridge is not ready at {origin}: {detail}")


def write_cloudflare_config(tunnel_id: str, _tunnel_name: str, hostname: str, origin_url: str) -> Path:
    CLOUDFLARE_LOG_DIR.mkdir(parents=True, exist_ok=True)
    cloudflare_home = Path.home() / ".cloudflared"
    cloudflare_home.mkdir(parents=True, exist_ok=True)
    credentials_file = cloudflare_credentials_file(tunnel_id)
    if not credentials_file.exists():
        raise RuntimeError(f"Cloudflare tunnel credentials file is missing: {credentials_file}")
    config = {
        "tunnel": tunnel_id,
        "credentials-file": str(credentials_file),
        "ingress": [
            {"hostname": hostname, "service": origin_url},
            {"service": "http_status:404"},
        ],
    }
    CLOUDFLARE_CONFIG_FILE.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    return CLOUDFLARE_CONFIG_FILE


def load_config_store(input_path: str | None = None) -> ConfigStore:
    raw_path = input_path or os.environ.get("DEXYD_CONFIG")
    if raw_path:
        path = Path(raw_path)
        if not path.is_absolute():
            path = (Path.cwd() / path).resolve()
    else:
        path = (Path.cwd() / "dexyd.config.yaml").resolve()

    if not path.exists():
        return ConfigStore(path=path, format="yaml", editable=True, config=copy.deepcopy(DEFAULT_CONFIG))

    ext = path.suffix.lower()
    text = path.read_text(encoding="utf-8")

    if ext in {".yaml", ".yml"}:
        parsed = yaml.safe_load(text) or {}
        fmt = "yaml"
        editable = True
    elif ext == ".json":
        parsed = json.loads(text)
        fmt = "json"
        editable = True
    elif ext == ".toml":
        import tomllib

        parsed = tomllib.loads(text)
        fmt = "toml"
        editable = False
    else:
        raise RuntimeError(f"Unsupported config extension: {ext}")

    if not isinstance(parsed, dict):
        raise RuntimeError("Config root must be an object/map")

    return ConfigStore(path=path, format=fmt, editable=editable, config=normalize_config(parsed))


def save_config_store(store: ConfigStore) -> None:
    if not store.editable:
        raise RuntimeError("TOML is read-only in this TUI. Use YAML or JSON for editing.")

    store.path.parent.mkdir(parents=True, exist_ok=True)
    if store.format == "json":
        store.path.write_text(json.dumps(store.config, indent=2) + "\n", encoding="utf-8")
    else:
        store.path.write_text(yaml.safe_dump(store.config, sort_keys=False), encoding="utf-8")


def bridge_url(config: dict[str, Any]) -> str:
    host = str(config["server"]["host"])
    if host == "0.0.0.0":
        host = "127.0.0.1"
    elif host == "::":
        host = "::1"
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"http://{host}:{config['server']['port']}"


def detect_lan_ipv4() -> str | None:
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        address = probe.getsockname()[0]
        return str(address) if address and not address.startswith("127.") else None
    except OSError:
        return None
    finally:
        probe.close()


def advertised_bridge_url(config: dict[str, Any]) -> str:
    public_url = config["server"].get("publicBaseUrl")
    if public_url:
        return public_url

    host = str(config["server"]["host"])
    if host in {"0.0.0.0", "::", ""}:
        return f"http://{detect_lan_ipv4() or '127.0.0.1'}:{config['server']['port']}"

    return bridge_url(config)


def http_json(
    url: str,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    timeout: int = 8,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    payload = None if body is None else json.dumps(body).encode("utf-8")
    request_headers = dict(headers or {})
    if payload is not None:
        request_headers.setdefault("Content-Type", "application/json")
    req = request.Request(url=url, data=payload, headers=request_headers, method=method)
    with request.urlopen(req, timeout=timeout) as response:
        raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def get_bridge_health_payload(base_url: str) -> tuple[dict[str, Any] | None, str]:
    try:
        result = http_json(f"{base_url}/health/ready", timeout=3)
        return result, "Bridge responded to /health/ready."
    except error.URLError:
        return None, "Cannot reach bridge. Start dexyd or npm run dev, then refresh."
    except Exception as exc:
        return None, str(exc)


def get_bridge_health(base_url: str) -> tuple[str, str]:
    result, detail = get_bridge_health_payload(base_url)
    if not result:
        return ("down" if detail.startswith("Cannot reach") else "error"), detail
    return str(result.get("status", "unknown")), detail


def opencode_server_base_url(config: dict[str, Any]) -> str:
    server = config["opencode"]["server"]
    host = str(server["host"])
    if host in {"0.0.0.0", "::", ""}:
        host = "127.0.0.1"
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"http://{host}:{server['port']}"


def opencode_auth_headers(config: dict[str, Any]) -> dict[str, str]:
    password = str(config.get("opencode", {}).get("server", {}).get("password") or "")
    if not password:
        return {}
    token = base64.b64encode(f"opencode:{password}".encode("utf-8")).decode("ascii")
    return {"Authorization": f"Basic {token}"}


def get_opencode_health(config: dict[str, Any]) -> tuple[str, str, str | None]:
    opencode = config.get("opencode", {})
    if not opencode.get("enabled"):
        return "disabled", "OpenCode integration disabled in config.", None
    base_url = opencode_server_base_url(config)
    try:
        result = http_json(f"{base_url}/global/health", timeout=2, headers=opencode_auth_headers(config))
        healthy = bool(result.get("healthy"))
        version = str(result.get("version") or "") or None
        return ("ready" if healthy else "degraded"), f"{base_url}/global/health responded.", version
    except error.URLError:
        return "stopped", f"Cannot reach OpenCode server at {base_url}.", None
    except Exception as exc:
        return "error", str(exc), None


def wait_for_bridge_ready(base_url: str, timeout_seconds: int = 90, pid: int | None = None) -> tuple[bool, str]:
    deadline = time.time() + timeout_seconds
    last_detail = "waiting"

    while time.time() < deadline:
        if pid is not None and not process_is_running(pid):
            return False, f"cloudflared exited before {base_url} became reachable. Check {CLOUDFLARE_LOG_FILE}"

        health, detail = get_bridge_health(base_url)
        last_detail = detail
        if health == "ready":
            return True, detail

        time.sleep(2)

    return False, f"{base_url} did not become ready within {timeout_seconds}s. Last check: {last_detail}"


def start_pairing(api_base_url: str, pairing_base_url: str, expires_in_seconds: int) -> dict[str, Any]:
    try:
        return http_json(
            f"{api_base_url}/pairing/start",
            method="POST",
            body={"expiresInSeconds": expires_in_seconds, "bridgeBaseUrl": pairing_base_url},
        )
    except error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Bridge rejected pairing request ({exc.code}): {details}") from exc
    except error.URLError as exc:
        raise RuntimeError(f"Cannot reach bridge at {api_base_url}. Is dexyd running?") from exc


def build_compact_pairing_uri(pairing: dict[str, Any]) -> str:
    payload = pairing.get("payload") if isinstance(pairing.get("payload"), dict) else {}
    pairing_id = str(pairing.get("pairingId") or payload.get("pairingId") or "")
    challenge = str(payload.get("challenge") or "")
    bridge_base_url = str(payload.get("bridgeBaseUrl") or pairing.get("bridgeBaseUrl") or "")

    if not pairing_id or not challenge:
        uri = pairing.get("pairingUri")
        if not uri:
            raise RuntimeError("Bridge did not return pairing id/challenge or pairing URI")
        return str(uri)

    query = {"pairingId": pairing_id, "challenge": challenge}
    if bridge_base_url:
        query["bridgeBaseUrl"] = bridge_base_url
    return f"dexyd://pair?{urlencode(query)}"


def render_terminal_qr(value: str) -> str:
    qr = qrcode.QRCode(border=4, error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(value)
    qr.make(fit=True)
    matrix = qr.get_matrix()

    if len(matrix) % 2 == 1:
        matrix.append([False] * len(matrix[0]))

    rows: list[str] = []
    for row_index in range(0, len(matrix), 2):
        upper = matrix[row_index]
        lower = matrix[row_index + 1]
        chars = []

        for top, bottom in zip(upper, lower):
            if top and bottom:
                chars.append("█")
            elif top and not bottom:
                chars.append("▀")
            elif not top and bottom:
                chars.append("▄")
            else:
                chars.append(" ")

        rows.append("".join(chars))

    return "\n".join(rows)


def sqlite_path_for(config: dict[str, Any]) -> Path:
    sqlite_path = Path(config["storage"]["sqlitePath"])
    return sqlite_path if sqlite_path.is_absolute() else (Path.cwd() / sqlite_path).resolve()


def opencode_sqlite_path_for(config: dict[str, Any]) -> Path:
    data_dir = Path(str(config["opencode"]["dataDir"])).expanduser()
    return (data_dir if data_dir.is_absolute() else (Path.cwd() / data_dir)).resolve() / "opencode.db"


def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME") or (Path.home() / ".codex")).expanduser().resolve()


def read_devices(sqlite_path: Path) -> list[DeviceRecord]:
    if not sqlite_path.exists():
        return []

    connection = sqlite3.connect(str(sqlite_path))
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            SELECT id, label, last_seen_at, trust_state, created_at
            FROM devices
            ORDER BY created_at DESC
            """
        )
        return [DeviceRecord(*row) for row in cursor.fetchall()]
    except sqlite3.Error:
        return []
    finally:
        connection.close()


def read_sessions(sqlite_path: Path, limit: int = 20) -> list[SessionRecord]:
    if not sqlite_path.exists():
        return []
    connection = sqlite3.connect(str(sqlite_path))
    try:
        cursor = connection.cursor()
        cursor.execute("PRAGMA table_info(sessions)")
        columns = {str(row[1]) for row in cursor.fetchall()}
        title_expr = "COALESCE(title, '')" if "title" in columns else "''"
        cursor.execute(
            f"""
            SELECT id, status, COALESCE(profile, 'default'), workspace_path, updated_at, {title_expr}
            FROM sessions
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (limit,),
        )
        return [
            SessionRecord(
                id=str(row[0]),
                status=str(row[1]),
                profile=str(row[2]),
                workspace_path=str(row[3]),
                updated_at=str(row[4]),
                title=str(row[5]) if row[5] else None,
                source="dexyd",
            )
            for row in cursor.fetchall()
        ]
    except sqlite3.Error:
        return []
    finally:
        connection.close()


def normalize_external_timestamp(value: Any) -> str:
    if isinstance(value, (int, float)) and value > 0:
        try:
            return dt.datetime.fromtimestamp(value / 1000 if value > 10_000_000_000 else value, tz=dt.timezone.utc).isoformat().replace("+00:00", "Z")
        except (OSError, OverflowError, ValueError):
            return "1970-01-01T00:00:00.000Z"
    raw = str(value or "").strip()
    if raw.isdigit():
        return normalize_external_timestamp(int(raw))
    if raw:
        try:
            parsed = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return parsed.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
        except ValueError:
            pass
    return "1970-01-01T00:00:00.000Z"


def sqlite_table_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    cursor = connection.cursor()
    cursor.execute(f"PRAGMA table_info({table})")
    return {str(row[1]) for row in cursor.fetchall()}


def sqlite_table_exists(connection: sqlite3.Connection, table: str) -> bool:
    cursor = connection.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,))
    return cursor.fetchone() is not None


def read_opencode_sessions(config: dict[str, Any], limit: int = 20) -> list[SessionRecord]:
    sqlite_path = opencode_sqlite_path_for(config)
    if not sqlite_path.exists():
        return []
    connection = sqlite3.connect(str(sqlite_path))
    try:
        if not sqlite_table_exists(connection, "session"):
            return []
        columns = sqlite_table_columns(connection, "session")
        select_optional = lambda name, fallback="NULL": f"s.{name} AS {name}" if name in columns else f"{fallback} AS {name}"
        order = "s.time_updated DESC" if "time_updated" in columns else "s.id DESC"
        cursor = connection.cursor()
        cursor.execute(
            f"""
            SELECT s.id,
                   {select_optional('directory', "''")},
                   {select_optional('path')},
                   {select_optional('title', "''")},
                   {select_optional('agent')},
                   {select_optional('model')},
                   {select_optional('time_created', "0")},
                   {select_optional('time_updated', "0")}
            FROM session s
            ORDER BY {order}
            LIMIT ?
            """,
            (limit,),
        )
        sessions: list[SessionRecord] = []
        for session_id, directory, path_value, title, agent, model, created_at, updated_at in cursor.fetchall():
            model_name = str(model or "")
            if model_name.startswith("{"):
                try:
                    parsed = json.loads(model_name)
                    if isinstance(parsed, dict):
                        model_name = str(parsed.get("id") or parsed.get("modelID") or model_name)
                except json.JSONDecodeError:
                    pass
            workspace = str(directory or path_value or "").strip()
            sessions.append(
                SessionRecord(
                    id=str(session_id),
                    status="idle",
                    profile="opencode",
                    workspace_path=workspace,
                    updated_at=normalize_external_timestamp(updated_at),
                    title=str(title).strip() or None,
                    source="opencode",
                    created_at=normalize_external_timestamp(created_at),
                    model=model_name or None,
                    agent=str(agent).strip() or None,
                )
            )
        return sessions
    except sqlite3.Error:
        return []
    finally:
        connection.close()


def read_codex_sessions(config: dict[str, Any], limit: int = 20) -> list[SessionRecord]:
    index_path = codex_home() / "session_index.jsonl"
    if not index_path.exists():
        return []
    try:
        lines = [line for line in index_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    except OSError:
        return []

    sessions: list[SessionRecord] = []
    workspace_root = str(workspace_root_for(config))
    for line in reversed(lines[-500:]):
        if len(sessions) >= limit:
            break
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(parsed, dict):
            continue
        session_id = str(parsed.get("id") or "").strip()
        if not session_id:
            continue
        title = str(parsed.get("thread_name") or parsed.get("title") or "").strip() or None
        updated = normalize_external_timestamp(parsed.get("updated_at") or parsed.get("timestamp"))
        sessions.append(
            SessionRecord(
                id=session_id,
                status="idle",
                profile="codex",
                workspace_path=workspace_root,
                updated_at=updated,
                title=title,
                source="codex",
                created_at=updated,
            )
        )
    return sessions


def read_visible_sessions(config: dict[str, Any], limit: int = 20) -> list[SessionRecord]:
    sqlite_path = sqlite_path_for(config)
    sessions = [
        *read_sessions(sqlite_path, limit=limit),
        *read_opencode_sessions(config, limit=limit),
        *read_codex_sessions(config, limit=limit),
    ]
    seen: set[str] = set()
    unique: list[SessionRecord] = []
    for session in sorted(sessions, key=lambda item: item.updated_at, reverse=True):
        if session.id in seen:
            continue
        seen.add(session.id)
        unique.append(session)
        if len(unique) >= limit:
            break
    return unique


def read_chat_messages(sqlite_path: Path, session_id: str, limit: int = 40) -> list[str]:
    if not sqlite_path.exists() or not session_id.strip():
        return []

    connection = sqlite3.connect(str(sqlite_path))
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            SELECT event_type, source, payload_json, created_at
            FROM events
            WHERE session_id = ? AND event_type LIKE 'chat.%'
            ORDER BY sequence DESC
            LIMIT ?
            """,
            (session_id.strip(), limit),
        )
        rows = list(reversed(cursor.fetchall()))
    except sqlite3.Error:
        return []
    finally:
        connection.close()

    messages: list[str] = []
    for event_type, source, payload_json, created_at in rows:
        try:
            payload = json.loads(payload_json or "{}")
        except json.JSONDecodeError:
            payload = {}
        content = str(payload.get("content") or payload.get("text") or payload.get("message") or "").strip()
        if not content and event_type == "chat.turn.started":
            content = "working…"
        if not content:
            continue
        role = event_type.replace("chat.message.", "") if event_type.startswith("chat.message.") else source
        messages.append(f"[{created_at}] {role}\n{content[:1600]}")
    return messages


def extract_opencode_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return "\n".join(filter(None, (extract_opencode_text(item) for item in value))).strip()
    if not isinstance(value, dict):
        return ""
    if isinstance(value.get("text"), str):
        return str(value["text"]).strip()
    if isinstance(value.get("content"), str):
        return str(value["content"]).strip()
    if isinstance(value.get("content"), list):
        return extract_opencode_text(value["content"])
    parts = value.get("parts")
    if isinstance(parts, list):
        return extract_opencode_text(parts)
    return ""


def parse_json_field(raw: Any) -> Any:
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(str(raw or "{}"))
    except json.JSONDecodeError:
        return {}


def read_opencode_chat_messages(config: dict[str, Any], session_id: str, limit: int = 40) -> list[str]:
    sqlite_path = opencode_sqlite_path_for(config)
    if not sqlite_path.exists() or not session_id.strip():
        return []
    connection = sqlite3.connect(str(sqlite_path))
    try:
        cursor = connection.cursor()
        if sqlite_table_exists(connection, "session_message"):
            cursor.execute(
                """
                SELECT type, data, time_created
                FROM session_message
                WHERE session_id = ?
                ORDER BY seq ASC
                LIMIT ?
                """,
                (session_id.strip(), limit),
            )
            rows = cursor.fetchall()
            if rows:
                messages: list[str] = []
                for role, raw_data, created_at in rows:
                    data = parse_json_field(raw_data)
                    content = extract_opencode_text(data) or extract_opencode_text(data.get("message") if isinstance(data, dict) else "")
                    if content:
                        messages.append(f"[{normalize_external_timestamp(created_at)}] {str(role)}\n{content[:1600]}")
                return messages

        if not sqlite_table_exists(connection, "message") or not sqlite_table_exists(connection, "part"):
            return []
        cursor.execute(
            """
            SELECT id, data, time_created
            FROM message
            WHERE session_id = ?
            ORDER BY time_created ASC, id ASC
            LIMIT ?
            """,
            (session_id.strip(), limit),
        )
        message_rows = cursor.fetchall()
        if not message_rows:
            return []
        cursor.execute(
            """
            SELECT message_id, data
            FROM part
            WHERE session_id = ?
            ORDER BY message_id ASC, time_created ASC, id ASC
            """,
            (session_id.strip(),),
        )
        parts_by_message: dict[str, list[Any]] = {}
        for message_id, raw_part in cursor.fetchall():
            parts_by_message.setdefault(str(message_id), []).append(parse_json_field(raw_part))
        messages = []
        for message_id, raw_message, created_at in message_rows:
            data = parse_json_field(raw_message)
            role = str(data.get("role") or "system") if isinstance(data, dict) else "system"
            content = extract_opencode_text({"parts": parts_by_message.get(str(message_id), [])}) or extract_opencode_text(data)
            if content:
                messages.append(f"[{normalize_external_timestamp(created_at)}] {role}\n{content[:1600]}")
        return messages
    except sqlite3.Error:
        return []
    finally:
        connection.close()


def read_any_chat_messages(config: dict[str, Any], session_id: str, limit: int = 40) -> list[str]:
    local = read_chat_messages(sqlite_path_for(config), session_id, limit=limit)
    if local:
        return local
    return read_opencode_chat_messages(config, session_id, limit=limit)


def ensure_dexyd_help_workspace(config: dict[str, Any]) -> Path:
    root = Path(str(config["codex"].get("workspaceRoot") or Path.home())).expanduser().resolve()
    help_dir = root / ".dexyd-help"
    help_dir.mkdir(parents=True, exist_ok=True)
    readme = help_dir / "README.md"
    readme.write_text(
        "# dexyd help workspace\n\n"
        "Use this workspace for questions about dexyd bridge, mobile pairing, TUI setup, Cloudflare/Caddy domains, OMX/Codex sessions, and troubleshooting.\n\n"
        "## Common commands\n\n"
        "- `npm run dev` starts the bridge.\n"
        "- `npm run tui` or `dexyd --tui` opens the TUI.\n"
        "- `dexyd --tui` opens the TUI after installation.\n"
        "- Pairing QR codes should be generated after choosing LAN/domain/tunnel connection mode.\n\n"
        "## Security notes\n\n"
        "Keep pairing windows short, revoke unused devices, prefer HTTPS domains/tunnels outside LAN, and rotate the signing key if credentials leak.\n",
        encoding="utf-8",
    )
    return help_dir


def user_service_dir() -> Path:
    service_dir = Path.home() / ".config" / "systemd" / "user"
    service_dir.mkdir(parents=True, exist_ok=True)
    return service_dir


def systemctl_user(args: list[str], timeout: int = 30) -> subprocess.CompletedProcess[str]:
    systemctl = shutil.which("systemctl")
    if not systemctl:
        return subprocess.CompletedProcess(["systemctl", "--user", *args], 127, "", "systemctl not found")
    return run_capture([systemctl, "--user", *args], timeout=timeout)


def user_service_state(name: str) -> tuple[str, str]:
    active = systemctl_user(["is-active", name], timeout=5)
    enabled = systemctl_user(["is-enabled", name], timeout=5)
    active_text = (active.stdout or active.stderr or "unknown").strip() or "unknown"
    enabled_text = (enabled.stdout or enabled.stderr or "unknown").strip() or "unknown"
    if active.returncode != 0 and active_text in {"", "unknown"}:
        active_text = "inactive"
    if enabled.returncode != 0 and enabled_text in {"", "unknown"}:
        enabled_text = "disabled"
    return active_text, enabled_text


def remove_legacy_tunnel_service() -> str:
    messages: list[str] = []
    stop = systemctl_user(["disable", "--now", "dexyd-cloudflared.service"], timeout=30)
    if stop.returncode == 0:
        messages.append("old tunnel service disabled")
    service_file = user_service_dir() / "dexyd-cloudflared.service"
    service_link = user_service_dir() / "default.target.wants" / "dexyd-cloudflared.service"
    for path in (service_file, service_link):
        try:
            path.unlink()
            messages.append(f"removed {path.name}")
        except FileNotFoundError:
            pass
    systemctl_user(["daemon-reload"], timeout=30)
    return "; ".join(messages)


def install_user_service(config_path: Path) -> str:
    repo_root = Path.cwd().resolve()
    runner = repo_root / "scripts" / "run-connection-service.sh"
    if not runner.exists():
        return f"Connection service runner is missing: {runner}"
    bridge_entry = repo_root / "dist" / "index.js"
    if not bridge_entry.exists():
        return (
            f"Connection service runner is present, but the bridge build is missing: {bridge_entry}\n"
            "Run the official installer again to rebuild the installed bridge."
        )
    runner.chmod(0o755)
    service_file = user_service_dir() / "dexyd.service"
    service_file.write_text(
        "[Unit]\n"
        "Description=dexyd connection service\n"
        "Wants=network-online.target\n"
        "After=network-online.target\n\n"
        "[Service]\n"
        f"WorkingDirectory={repo_root}\n"
        f"Environment=DEXYD_CONFIG={config_path}\n"
        f"ExecStart={runner}\n"
        "Restart=on-failure\n"
        "RestartSec=3\n\n"
        "[Install]\n"
        "WantedBy=default.target\n",
        encoding="utf-8",
    )
    for command in (["daemon-reload"], ["enable", "--now", "dexyd.service"]):
        result = systemctl_user(list(command), timeout=30)
        if result.returncode != 0:
            return f"Service file written: {service_file}\nCommand failed: systemctl --user {' '.join(command)}\n{result.stderr or result.stdout}"
    legacy = remove_legacy_tunnel_service()
    legacy_text = f"\nLegacy cleanup: {legacy}" if legacy else ""
    return (
        f"Dexyd connection service enabled and running: {service_file}\n"
        "This single service starts the bridge and, when configured, the Cloudflare tunnel."
        f"{legacy_text}\nCheck with: systemctl --user status dexyd.service"
    )


def restart_connection_user_service() -> str:
    result = systemctl_user(["restart", "dexyd.service"], timeout=30)
    if result.returncode != 0:
        return f"Could not restart Dexyd connection service.\n{result.stderr or result.stdout}"
    return "Dexyd connection service restarted."


def stop_connection_user_service() -> str:
    result = systemctl_user(["stop", "dexyd.service"], timeout=30)
    stop_pid(read_pid(CLOUDFLARE_PID_FILE))
    if result.returncode != 0:
        return f"Could not stop Dexyd connection service.\n{result.stderr or result.stdout}"
    return "Dexyd connection service stopped."


def disable_cloudflare_tunnel_config() -> str:
    messages: list[str] = []
    if CLOUDFLARE_CONFIG_FILE.exists():
        disabled = CLOUDFLARE_CONFIG_FILE.with_suffix(".yml.disabled")
        CLOUDFLARE_CONFIG_FILE.replace(disabled)
        messages.append(f"Tunnel config disabled: {disabled}")
    else:
        messages.append("No active tunnel config found.")
    if stop_pid(read_pid(CLOUDFLARE_PID_FILE)):
        messages.append("Stopped temporary tunnel process.")
    restart = restart_connection_user_service()
    messages.append(restart)
    return "\n".join(messages)


def read_session_count(sqlite_path: Path) -> int:
    if not sqlite_path.exists():
        return 0
    connection = sqlite3.connect(str(sqlite_path))
    try:
        cursor = connection.cursor()
        cursor.execute("SELECT COUNT(*) FROM sessions")
        row = cursor.fetchone()
        return int(row[0] if row else 0)
    except sqlite3.Error:
        return 0
    finally:
        connection.close()



def workspace_root_for(config: dict[str, Any]) -> Path:
    return Path(str(config["codex"].get("workspaceRoot") or Path.home())).expanduser().resolve()


def resolve_workspace_child(config: dict[str, Any], value: str) -> Path:
    root = workspace_root_for(config)
    raw = value.strip() or str(root)
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    resolved = candidate.resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise RuntimeError(f"Project path must stay inside workspace root: {root}") from exc
    return resolved


def list_projects(config: dict[str, Any], limit: int = 40) -> list[Path]:
    root = workspace_root_for(config)
    if not root.exists():
        return []
    projects: list[Path] = []
    for child in sorted(root.iterdir(), key=lambda item: item.name.lower()):
        if len(projects) >= limit:
            break
        if not child.is_dir() or child.name.startswith("."):
            continue
        projects.append(child.resolve())
    return projects


def create_project_dir(config: dict[str, Any], path_value: str) -> Path:
    path = resolve_workspace_child(config, path_value)
    path.mkdir(parents=True, exist_ok=True)
    return path


def ensure_session_tables(sqlite_path: Path) -> None:
    if not sqlite_path.exists():
        raise RuntimeError("Dexyd database is missing. Start the bridge once before managing sessions in the TUI.")


def create_local_session(sqlite_path: Path, workspace_path: str, title: str) -> str:
    ensure_session_tables(sqlite_path)
    session_id = secrets.token_hex(16)
    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    connection = sqlite3.connect(str(sqlite_path))
    try:
        cursor = connection.cursor()
        cursor.execute("PRAGMA table_info(sessions)")
        columns = {str(row[1]) for row in cursor.fetchall()}
        if "title" in columns:
            cursor.execute(
                """
                INSERT INTO sessions (id, status, workspace_path, created_at, updated_at, profile, title)
                VALUES (?, 'created', ?, ?, ?, 'default', ?)
                """,
                (session_id, workspace_path, now, now, title.strip() or Path(workspace_path).name),
            )
        else:
            cursor.execute(
                """
                INSERT INTO sessions (id, status, workspace_path, created_at, updated_at, profile)
                VALUES (?, 'created', ?, ?, ?, 'default')
                """,
                (session_id, workspace_path, now, now),
            )
        connection.commit()
    finally:
        connection.close()
    return session_id


def codex_session_file_timestamp(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z").replace(":", "-").replace(".", "-")


def create_codex_session(config: dict[str, Any], workspace_path: str, title: str) -> str:
    workspace = Path(workspace_path).expanduser().resolve()
    if not workspace.exists():
        raise RuntimeError(f"Workspace does not exist: {workspace}")
    session_id = str(uuid.uuid4())
    now = dt.datetime.now(dt.timezone.utc)
    timestamp = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    session_dir = codex_home() / "sessions" / f"{now.year:04d}" / f"{now.month:02d}" / f"{now.day:02d}"
    session_dir.mkdir(parents=True, exist_ok=True)
    codex_home().mkdir(parents=True, exist_ok=True)
    session_path = session_dir / f"rollout-{codex_session_file_timestamp(now)}-{session_id}.jsonl"
    clean_title = re.sub(r"\s+", " ", title or "").strip()[:120] or workspace.name or "Dexyd session"
    meta = {
        "timestamp": timestamp,
        "type": "session_meta",
        "payload": {
            "id": session_id,
            "timestamp": timestamp,
            "cwd": str(workspace),
            "originator": "dexyd",
            "source": "dexyd-tui",
            "thread_source": "user",
        },
    }
    with session_path.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(meta, separators=(",", ":")) + "\n")
    with (codex_home() / "session_index.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"id": session_id, "thread_name": clean_title, "updated_at": timestamp}, separators=(",", ":")) + "\n")
    return session_id


def create_opencode_session(config: dict[str, Any], title: str) -> str:
    if not config["opencode"].get("enabled"):
        raise RuntimeError("OpenCode integration is disabled. Switch to OpenCode or enable it in Advanced first.")
    body: dict[str, Any] = {}
    clean_title = re.sub(r"\s+", " ", title or "").strip()[:200]
    if clean_title:
        body["title"] = clean_title
    agent = str(config["opencode"].get("defaultAgent") or "").strip()
    if agent:
        body["agent"] = agent
    default_model = str(config["opencode"].get("defaultModel") or "").strip()
    if "/" in default_model:
        provider, model = default_model.split("/", 1)
        if provider and model:
            body["providerID"] = provider
            body["modelID"] = model
    result = http_json(
        f"{opencode_server_base_url(config)}/session",
        method="POST",
        body=body,
        timeout=10,
        headers=opencode_auth_headers(config),
    )
    session_id = str(result.get("id") or result.get("sessionID") or "").strip()
    if not session_id and isinstance(result.get("session"), dict):
        session_id = str(result["session"].get("id") or "").strip()
    if not session_id:
        raise RuntimeError(f"OpenCode did not return a session id: {result}")
    return session_id


def set_local_session_status(sqlite_path: Path, session_id: str, status: str) -> bool:
    if status not in {"created", "running", "idle", "completed", "failed", "cancelled"}:
        raise RuntimeError("Invalid session status")
    ensure_session_tables(sqlite_path)
    connection = sqlite3.connect(str(sqlite_path))
    try:
        result = connection.execute(
            "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
            (status, time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), session_id.strip()),
        )
        connection.commit()
        return result.rowcount > 0
    finally:
        connection.close()


def delete_or_hide_session(sqlite_path: Path, session_id: str) -> tuple[bool, bool]:
    session_id = session_id.strip()
    if not session_id:
        raise RuntimeError("Enter a session id first")
    ensure_session_tables(sqlite_path)
    connection = sqlite3.connect(str(sqlite_path))
    try:
        cursor = connection.cursor()
        cursor.execute("DELETE FROM events WHERE session_id = ?", (session_id,))
        result = cursor.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        cursor.execute(
            "INSERT OR REPLACE INTO hidden_sessions (id, hidden_at) VALUES (?, ?)",
            (session_id, time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())),
        )
        connection.commit()
        return result.rowcount > 0, True
    finally:
        connection.close()


def project_list_text(config: dict[str, Any]) -> str:
    root = workspace_root_for(config)
    projects = list_projects(config)
    if not projects:
        return f"PROJECTS\n\nNo project folders found under {root}."
    rows = ["PROJECTS", "", f"Root: {root}", ""]
    rows.extend(f"{index}. {path.name}\n   {path}" for index, path in enumerate(projects, start=1))
    return "\n\n".join(rows)

def git_diff_summary(workspace_path: str) -> str:
    path = Path(workspace_path)
    if not path.exists():
        return f"Workspace does not exist: {workspace_path}"
    try:
        status = subprocess.run(["git", "-C", workspace_path, "status", "--short"], check=False, capture_output=True, text=True, timeout=5)
        stat = subprocess.run(["git", "-C", workspace_path, "diff", "--no-ext-diff", "--stat"], check=False, capture_output=True, text=True, timeout=5)
        diff = subprocess.run(["git", "-C", workspace_path, "diff", "--no-ext-diff"], check=False, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError) as exc:
        return f"Unable to run git diff: {exc}"

    raw = (
        "STATUS\n" + (status.stdout.strip() or "No status changes.") +
        "\n\nSTAT\n" + (stat.stdout.strip() or "No diff stat.") +
        "\n\nDIFF\n" + (diff.stdout.strip() or "No unstaged diff.")
    )
    return raw[:12000] + ("\n\n[truncated]" if len(raw) > 12000 else "")


class ConfirmScreen(ModalScreen[bool]):
    CSS = """
    ConfirmScreen {
      align: center middle;
    }
    """

    def __init__(self, title: str, message: str, confirm_label: str = "Overwrite") -> None:
        super().__init__()
        self.dialog_title = title
        self.message = message
        self.confirm_label = confirm_label

    def compose(self) -> ComposeResult:
        with Vertical(classes="confirm_dialog"):
            yield Static(self.dialog_title, classes="section_title")
            yield Static(self.message, classes="field_help")
            with Horizontal(classes="action_row"):
                yield Button(self.confirm_label, id="confirm_yes", variant="error")
                yield Button("Cancel", id="confirm_no")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.dismiss(event.button.id == "confirm_yes")


class DexydTextualApp(App[None]):
    TITLE = "dexyd bridge console"
    SUB_TITLE = "local bridge"
    BINDINGS = [("q", "quit", "Quit"), ("r", "refresh", "Refresh")]

    CSS = """
    Screen {
      background: #171719;
      color: #f2f2f2;
      layout: vertical;
    }
    Header {
      background: #1f1f22;
      color: #f2f2f2;
    }
    Footer {
      background: #1f1f22;
    }
    TabbedContent {
      height: 1fr;
    }
    TabPane {
      padding: 0 1;
    }
    .page {
      height: 1fr;
    }
    .hero {
      border-left: thick #64d98b;
      background: #202024;
      padding: 1 2;
      margin-bottom: 1;
      height: auto;
    }
    .panel {
      border: round #323238;
      background: #202024;
      padding: 1 2;
      margin: 0 1 1 0;
      height: auto;
    }
    .soft_panel {
      background: #1b1b1f;
      padding: 1 2;
      margin: 0 1 1 0;
      height: auto;
    }
    .section_title {
      color: #f7faff;
      text-style: bold;
      margin-bottom: 1;
    }
    .field_label {
      color: #f7faff;
      text-style: bold;
      margin-top: 1;
    }
    .field_help {
      color: #a7a7ad;
      margin-bottom: 1;
    }
    .muted {
      color: #a7a7ad;
    }
    .success {
      color: #64d98b;
      text-style: bold;
    }
    .warning {
      color: #f2b84b;
      text-style: bold;
    }
    .danger {
      color: #ff6b61;
      text-style: bold;
    }
    .row {
      height: auto;
      width: 1fr;
      margin-bottom: 1;
    }
    .col {
      width: 1fr;
      min-width: 0;
      height: auto;
    }
    .actions {
      height: auto;
      width: 1fr;
      margin-bottom: 1;
    }
    .action_row {
      height: auto;
      width: 1fr;
      margin-bottom: 1;
    }
    Input {
      margin-bottom: 1;
      width: 1fr;
    }
    Button {
      margin: 1 0 0 0;
      width: 1fr;
      min-width: 0;
    }
    #qr_output {
      border: round #64d98b;
      background: #111113;
      padding: 1;
      width: 1fr;
      height: auto;
      min-height: 10;
      overflow: auto auto;
    }
    #device_output, #session_output, #chat_output, #diff_output, #cloudflare_output, #update_output {
      border: round #323238;
      padding: 1;
      overflow: auto auto;
    }
    #device_output, #session_output {
      min-height: 8;
    }
    #cloudflare_output, #update_output {
      height: 14;
      min-height: 8;
      max-height: 16;
    }
    #bridge_config_status {
      min-height: 9;
    }
    .confirm_dialog {
      align: center middle;
      width: 70;
      height: auto;
      border: round #f2b84b;
      background: #202024;
      padding: 1 2;
    }
    #status_line {
      dock: bottom;
      height: 1;
      padding: 0 1;
      color: #f7faff;
      background: #202024;
    }
    """

    def __init__(self, config_path: str | None = None) -> None:
        super().__init__()
        self.store = load_config_store(config_path)
        self.last_pairing_uri = ""
        self.cloudflare_log_text = ""
        self.cloudflare_busy = False
        self.update_log_text = ""
        self.update_busy = False
        self.update_info: UpdateInfo | None = None
        self.update_relaunch_pending = False

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with TabbedContent(id="main"):
            with TabPane("Assistant", id="assistant"):
                with VerticalScroll(classes="page"):
                    yield Static(
                        "ASSISTANT MODE\n\n"
                        "Choose what new sessions use. Codex / OMX writes normal Codex sessions and honors the configured harness. "
                        "OpenCode talks to the configured local OpenCode server and shows OpenCode sessions.",
                        classes="hero",
                    )
                    yield Static("", id="assistant_mode_status_big", classes="panel")
                    with Horizontal(classes="action_row"):
                        yield Button("Switch to Codex / OMX", id="assistant_use_codex_mode", variant="primary")
                        yield Button("Switch to OpenCode", id="assistant_use_opencode_mode", variant="success")
                    yield Static(
                        "TIP\n\n"
                        "After switching, use Work → Create session. If OpenCode shows stopped, start dexyd.service or run OpenCode on the configured host/port.",
                        classes="soft_panel",
                    )

            with TabPane("Home", id="dashboard"):
                with VerticalScroll(classes="page"):
                    yield Static("", id="dashboard_hero", classes="hero")
                    with Horizontal(classes="row"):
                        yield Static("", id="bridge_card", classes="panel col")
                        yield Static("", id="storage_card", classes="panel col")
                    with Horizontal(classes="row"):
                        yield Static("", id="security_card", classes="panel col")
                        yield Static("", id="assistant_card", classes="panel col")
                        yield Static("", id="next_steps_card", classes="panel col")
                    with Horizontal(classes="action_row"):
                        yield Button("Refresh", id="refresh_dashboard", variant="primary")
                        yield Button("Check updates", id="check_updates")
                        yield Button("Reload config", id="reload_config")

            with TabPane("Connection", id="connection"):
                with VerticalScroll(classes="page"):
                    yield Static(
                        "CONNECTION\n\nOperate the bridge and the Cloudflare tunnel from one clean screen. Configure host, port, tunnel name, and tunnel URL in Advanced settings.",
                        classes="hero",
                    )
                    yield Static("", id="bridge_config_status", classes="panel")
                    with Horizontal(classes="action_row"):
                        yield Button("Start bridge", id="install_service", variant="success")
                        yield Button("Stop bridge", id="stop_connection_service", variant="error")
                        yield Button("Start tunnel", id="cf_start_named", variant="success")
                        yield Button("Stop tunnel", id="cf_disable_tunnel", variant="error")
                    with Horizontal(classes="row"):
                        with Vertical(classes="panel col"):
                            yield Static("PAIR PHONE", classes="section_title")
                            yield Static("Expiry seconds", classes="field_label")
                            yield Static("Short-lived pairing challenge. 300 seconds is usually enough.", classes="field_help")
                            yield Input(placeholder="300", id="pairing_expiry", type="integer", value="300")
                            with Vertical(classes="actions"):
                                yield Button("Generate pairing QR", id="generate_pairing", variant="success")
                                yield Button("Clear", id="clear_qr")
                        yield Static(
                            "FLOW\n\n1. Configure LAN or Cloudflare in Advanced.\n2. Start bridge.\n3. Start tunnel if using Cloudflare.\n4. Generate QR after the status shows the URL you want.\n\nChanging the URL requires a new QR.",
                            classes="soft_panel col",
                        )
                    yield Static("Generate a QR to pair the mobile app.", id="qr_output")
                    yield Static("", id="cloudflare_output")

            with TabPane("Work", id="sessions"):
                with VerticalScroll(classes="page"):
                    yield Static("WORKSPACES & SESSIONS\n\nSwitch the default assistant, create Codex/OpenCode sessions, inspect recent sessions, and view chat/diff snippets from the bridge side.", classes="hero")
                    with Horizontal(classes="row"):
                        with Vertical(classes="panel col"):
                            yield Static("ASSISTANT MODE", classes="section_title")
                            yield Static("", id="assistant_mode_status")
                            with Horizontal(classes="action_row"):
                                yield Button("Use Codex / OMX", id="use_codex_mode", variant="primary")
                                yield Button("Use OpenCode", id="use_opencode_mode", variant="success")
                        yield Static(
                            "MODE HELP\n\nCodex mode creates sessions in ~/.codex and honors the Codex/OMX harness settings used by the bridge. OpenCode mode creates sessions through the local OpenCode server and shows OpenCode SQLite-backed sessions/messages.",
                            classes="soft_panel col",
                        )
                    with Horizontal(classes="row"):
                        with Vertical(classes="panel col"):
                            yield Static("PROJECT", classes="section_title")
                            yield Static("Project path", classes="field_label")
                            yield Static("Absolute path or relative to the configured workspace root.", classes="field_help")
                            yield Input(placeholder="my-project or /home/me/project", id="project_path")
                            with Vertical(classes="actions"):
                                yield Button("Create project", id="create_project", variant="success")
                                yield Button("Refresh projects", id="refresh_projects")
                            yield Static("", id="project_output")
                        with Vertical(classes="panel col"):
                            yield Static("SESSION", classes="section_title")
                            yield Static("Session id", classes="field_label")
                            yield Input(placeholder="Session id to inspect/manage", id="chat_session_id")
                            yield Static("New session title", classes="field_label")
                            yield Input(placeholder="Optional title", id="session_title")
                            yield Static("Status", classes="field_label")
                            yield Input(placeholder="idle | completed | cancelled | failed", id="session_status", value="idle")
                            with Vertical(classes="actions"):
                                yield Button("Create session", id="create_session", variant="success")
                                yield Button("Set status", id="set_session_status")
                            with Vertical(classes="actions"):
                                yield Button("Delete/hide", id="delete_session", variant="error")
                                yield Button("Dexyd help chat", id="open_dexyd_chat")
                    with Horizontal(classes="action_row"):
                        yield Button("Refresh sessions", id="refresh_sessions", variant="primary")
                        yield Button("Show chat", id="show_chat")
                    yield Static("", id="session_output")
                    yield Static("", id="chat_output")
                    yield Static("", id="diff_output")

            with TabPane("Devices", id="devices"):
                with VerticalScroll(classes="page"):
                    yield Static("TRUSTED DEVICES\n\nPhones paired with this bridge. Revoke from the mobile Security screen when a phone is lost or replaced.", classes="hero")
                    with Horizontal(classes="action_row"):
                        yield Button("Refresh devices", id="refresh_devices", variant="primary")
                    yield Static("", id="device_output")

            with TabPane("Advanced", id="settings"):
                with VerticalScroll(classes="page"):
                    yield Static("ADVANCED SETTINGS\n\nLess common runtime, security, stream, and harness settings. Save here after editing, then restart the bridge/service.", classes="hero")
                    with Horizontal(classes="row"):
                        with Vertical(classes="panel col"):
                            yield Static("CONNECTION SETTINGS", classes="section_title")
                            yield Static("Server host", classes="field_label")
                            yield Static("Use 0.0.0.0 for LAN phone access. Use 127.0.0.1 behind a local tunnel/proxy.", classes="field_help")
                            yield Input(placeholder="0.0.0.0", id="cfg_server_host")
                            yield Static("Server port", classes="field_label")
                            yield Static("Bridge HTTP/WebSocket port.", classes="field_help")
                            yield Input(placeholder="4242", id="cfg_server_port", type="integer")
                            yield Static("Public bridge URL", classes="field_label")
                            yield Static("Leave empty for LAN. Set an HTTPS domain/tunnel before generating a remote QR.", classes="field_help")
                            yield Input(placeholder="https://dexyd.example.com", id="cfg_server_public_base_url")
                            with Vertical(classes="actions"):
                                yield Button("Save connection settings", id="save_connection", variant="success")
                                yield Button("Reload config", id="reload_config")
                        with Vertical(classes="panel col"):
                            yield Static("CLOUDFLARE SETTINGS", classes="section_title")
                            yield Static("Public hostname", classes="field_label")
                            yield Static("Hostname routed in Cloudflare, e.g. dexyd.example.com.", classes="field_help")
                            yield Input(placeholder="dexyd.example.com", id="cf_hostname")
                            yield Static("Tunnel name", classes="field_label")
                            yield Static("Reusable named tunnel label. Duplicates require confirmation.", classes="field_help")
                            yield Input(placeholder="dexyd", id="cf_tunnel_name", value="dexyd")
                            with Vertical(classes="actions"):
                                yield Button("Configure tunnel", id="cf_configure", variant="success")
                                yield Button("Login", id="cf_login")
                                yield Button("Install cloudflared", id="cf_install")
                    with Horizontal(classes="row"):
                        with Vertical(classes="panel col"):
                            yield Static("SECURITY", classes="section_title")
                            yield Static("Access token TTL", classes="field_label")
                            yield Static("Short-lived mobile API token lifetime.", classes="field_help")
                            yield Input(placeholder="900", id="cfg_auth_access_ttl", type="integer")
                            yield Static("Refresh token TTL", classes="field_label")
                            yield Static("Trusted device refresh lifetime.", classes="field_help")
                            yield Input(placeholder="2592000", id="cfg_auth_refresh_ttl", type="integer")
                            yield Static("Signing key", classes="field_label")
                            yield Static("Minimum 16 characters. Changing it invalidates access tokens.", classes="field_help")
                            yield Input(placeholder="Signing key", id="cfg_auth_signing_key", password=True)
                        with Vertical(classes="panel col"):
                            yield Static("STREAM", classes="section_title")
                            yield Static("Replay window", classes="field_label")
                            yield Static("How long recent events remain replayable after disconnects.", classes="field_help")
                            yield Input(placeholder="600", id="cfg_stream_replay", type="integer")
                            yield Static("Idle heartbeat", classes="field_label")
                            yield Static("Idle websocket heartbeat seconds.", classes="field_help")
                            yield Input(placeholder="50", id="cfg_stream_idle", type="integer")
                            yield Static("Log level", classes="field_label")
                            yield Static("fatal, error, warn, info, debug, or trace.", classes="field_help")
                            yield Input(placeholder="info", id="cfg_server_log_level")
                    with Horizontal(classes="row"):
                        with Vertical(classes="panel col"):
                            yield Static("CODEX / HARNESS", classes="section_title")
                            yield Static("Codex runtime", classes="field_label")
                            yield Static("Codex CLI command for direct mode.", classes="field_help")
                            yield Input(placeholder="codex", id="cfg_codex_runtime_path")
                            yield Static("Workspace root", classes="field_label")
                            yield Static("Project/session root visible to paired devices.", classes="field_help")
                            yield Input(placeholder="/path/to/workspace", id="cfg_codex_workspace_root")
                            yield Static("Permission mode", classes="field_label")
                            yield Static("bypass matches unsandboxed desktop-style runs; inherit uses Codex config.", classes="field_help")
                            yield Input(placeholder="bypass | inherit | workspace-write", id="cfg_codex_permission_mode")
                            yield Static("Harness mode", classes="field_label")
                            yield Static("direct, omx, or custom.", classes="field_help")
                            yield Input(placeholder="direct | omx | custom", id="cfg_codex_harness_mode")
                            yield Static("Harness command", classes="field_label")
                            yield Static("Wrapper command, e.g. omx.", classes="field_help")
                            yield Input(placeholder="omx", id="cfg_codex_harness_command")
                            yield Static("Harness args", classes="field_label")
                            yield Static("Optional args before exec.", classes="field_help")
                            yield Input(placeholder="--profile mobile", id="cfg_codex_harness_args")
                        yield Static("", id="settings_summary", classes="panel col")
                    with Horizontal(classes="row"):
                        with Vertical(classes="panel col"):
                            yield Static("ASSISTANT DEFAULT", classes="section_title")
                            yield Static("Default mode", classes="field_label")
                            yield Static("codex uses Codex/OMX; opencode uses OpenCode sessions.", classes="field_help")
                            yield Input(placeholder="codex | opencode", id="cfg_assistant_mode")
                            with Horizontal(classes="action_row"):
                                yield Button("Codex default", id="advanced_use_codex_mode")
                                yield Button("OpenCode default", id="advanced_use_opencode_mode")
                        with Vertical(classes="panel col"):
                            yield Static("OPENCODE", classes="section_title")
                            yield Static("Enabled", classes="field_label")
                            yield Static("true or false. When true, the bridge can auto-start/adopt opencode serve.", classes="field_help")
                            yield Input(placeholder="true", id="cfg_opencode_enabled")
                            yield Static("Runtime", classes="field_label")
                            yield Input(placeholder="opencode", id="cfg_opencode_runtime_path")
                            yield Static("Data dir", classes="field_label")
                            yield Input(placeholder="~/.local/share/opencode", id="cfg_opencode_data_dir")
                            yield Static("Server host", classes="field_label")
                            yield Input(placeholder="127.0.0.1", id="cfg_opencode_server_host")
                            yield Static("Server port", classes="field_label")
                            yield Input(placeholder="4243", id="cfg_opencode_server_port", type="integer")
                            yield Static("Default agent", classes="field_label")
                            yield Input(placeholder="build", id="cfg_opencode_default_agent")
                            yield Static("Default model", classes="field_label")
                            yield Static("Optional provider/model, e.g. anthropic/claude-sonnet-4.", classes="field_help")
                            yield Input(placeholder="provider/model", id="cfg_opencode_default_model")
                            yield Static("Permission mode", classes="field_label")
                            yield Input(placeholder="bypass | inherit | workspace-write", id="cfg_opencode_permission_mode")
                            yield Static("Server password", classes="field_label")
                            yield Static("Optional OPENCODE_SERVER_PASSWORD for protected servers.", classes="field_help")
                            yield Input(placeholder="optional", id="cfg_opencode_server_password", password=True)
                    with Horizontal(classes="action_row"):
                        yield Button("Save advanced settings", id="save_settings", variant="success")
                        yield Button("Reset form", id="reset_settings")

            with TabPane("Updates", id="updates"):
                with VerticalScroll(classes="page"):
                    yield Static(
                        "UPDATES\n\n"
                        "Check GitHub Releases, update the installed bridge/TUI, and find the latest Android APK. "
                        "Bridge updates preserve config and data.",
                        classes="hero",
                    )
                    with Horizontal(classes="action_row"):
                        yield Button("Check updates", id="check_updates", variant="primary")
                        yield Button("Install / repair bridge", id="install_update", variant="success")
                    yield Static("", id="update_output")

            with TabPane("Help", id="help"):
                with VerticalScroll(classes="page"):
                    yield Static(
                        "DEXYD HELP\n\n"
                        "Recommended setup:\n"
                        "  1. Connection: choose LAN or Cloudflare/domain and save.\n"
                        "  2. Connection: install/start Dexyd service. One service runs bridge + tunnel.\n"
                        "  3. Connection: generate a fresh QR and scan it in the mobile app.\n"
                        "  4. Work: verify sessions/projects are visible.\n"
                        "  5. Updates: check bridge/TUI and APK releases.\n\n"
                        "Commands:\n"
                        "  dexyd --tui          open this console\n"
                        "  dexyd                run bridge in foreground\n"
                        "  systemctl --user status dexyd.service\n\n"
                        "Keyboard:\n"
                        "  r refresh · q quit\n\n"
                        "Safety:\n"
                        "  Pairing QRs are short-lived. Regenerate after changing URLs. Keep workspaceRoot scoped to files you trust paired devices to access.",
                        classes="panel",
                    )

        yield Static("Ready", id="status_line")
        yield Footer()

    def on_mount(self) -> None:
        self._load_settings_inputs()
        self.refresh_all()
        self.refresh_settings_summary()
        self.refresh_assistant_status()
        self.refresh_cloudflare()
        self.refresh_updates()

    def action_refresh(self) -> None:
        self.refresh_all()
        self.set_status("Refreshed dashboard, sessions, and devices")

    def refresh_all(self) -> None:
        self.refresh_dashboard()
        self.refresh_devices()
        self.refresh_sessions()
        self.refresh_projects()
        self.refresh_cloudflare()
        self.refresh_bridge_config_status()
        self.refresh_assistant_status()
        self.refresh_updates()

    def reload_config(self) -> None:
        self.store = load_config_store(str(self.store.path))
        self._load_settings_inputs()
        self.refresh_all()
        self.refresh_settings_summary()

    def set_status(self, message: str) -> None:
        self.query_one("#status_line", Static).update(message)

    def _load_settings_inputs(self) -> None:
        config = self.store.config
        self.query_one("#cfg_server_host", Input).value = str(config["server"]["host"])
        self.query_one("#cfg_server_port", Input).value = str(config["server"]["port"])
        self.query_one("#cfg_server_log_level", Input).value = str(config["server"]["logLevel"])
        public_base_url = str(config["server"].get("publicBaseUrl") or "")
        self.query_one("#cfg_server_public_base_url", Input).value = public_base_url
        metadata = read_cloudflare_metadata()
        cloudflare_config = config.get("cloudflare") if isinstance(config.get("cloudflare"), dict) else {}
        public_hostname = normalize_cloudflare_hostname(public_base_url)
        saved_hostname = normalize_cloudflare_hostname(
            cloudflare_config.get("hostname") or metadata.get("hostname") or public_hostname
        )
        saved_tunnel_name = normalized_tunnel_name(
            cloudflare_config.get("tunnelName") or metadata.get("tunnelName") or metadata.get("requestedTunnelName") or "dexyd"
        )
        self.query_one("#cf_hostname", Input).value = saved_hostname
        self.query_one("#cf_tunnel_name", Input).value = saved_tunnel_name
        self.query_one("#cfg_auth_access_ttl", Input).value = str(config["auth"]["accessTokenTtlSeconds"])
        self.query_one("#cfg_auth_refresh_ttl", Input).value = str(config["auth"]["refreshTokenTtlSeconds"])
        self.query_one("#cfg_auth_signing_key", Input).value = str(config["auth"]["signingKey"])
        self.query_one("#cfg_stream_replay", Input).value = str(config["stream"]["replayWindowSeconds"])
        self.query_one("#cfg_stream_idle", Input).value = str(config["stream"]["heartbeatIdleSeconds"])
        harness = config["codex"]["harness"]
        self.query_one("#cfg_codex_runtime_path", Input).value = str(config["codex"]["runtimePath"])
        self.query_one("#cfg_codex_workspace_root", Input).value = str(config["codex"]["workspaceRoot"])
        self.query_one("#cfg_codex_permission_mode", Input).value = str(config["codex"].get("permissionMode") or DEFAULT_CONFIG["codex"]["permissionMode"])
        self.query_one("#cfg_codex_harness_mode", Input).value = str(harness["mode"])
        self.query_one("#cfg_codex_harness_command", Input).value = str(harness["command"])
        self.query_one("#cfg_codex_harness_args", Input).value = shlex.join([str(arg) for arg in harness.get("args", [])])
        opencode = config["opencode"]
        opencode_server = opencode["server"]
        self.query_one("#cfg_assistant_mode", Input).value = normalize_assistant_mode(config.get("assistant", {}))
        self.query_one("#cfg_opencode_enabled", Input).value = "true" if opencode.get("enabled") else "false"
        self.query_one("#cfg_opencode_runtime_path", Input).value = str(opencode.get("runtimePath") or "opencode")
        self.query_one("#cfg_opencode_data_dir", Input).value = str(opencode.get("dataDir") or DEFAULT_CONFIG["opencode"]["dataDir"])
        self.query_one("#cfg_opencode_server_host", Input).value = str(opencode_server.get("host") or "127.0.0.1")
        self.query_one("#cfg_opencode_server_port", Input).value = str(opencode_server.get("port") or 4243)
        self.query_one("#cfg_opencode_default_agent", Input).value = str(opencode.get("defaultAgent") or "build")
        self.query_one("#cfg_opencode_default_model", Input).value = str(opencode.get("defaultModel") or "")
        self.query_one("#cfg_opencode_permission_mode", Input).value = str(opencode.get("permissionMode") or DEFAULT_CONFIG["opencode"]["permissionMode"])
        self.query_one("#cfg_opencode_server_password", Input).value = str(opencode_server.get("password") or "")

    def save_cloudflare_settings_from_inputs(self, persist: bool = True) -> tuple[str, str]:
        hostname = normalize_cloudflare_hostname(self.query_one("#cf_hostname", Input).value)
        tunnel_name = normalized_tunnel_name(self.query_one("#cf_tunnel_name", Input).value)
        self.store.config.setdefault("cloudflare", {})
        self.store.config["cloudflare"]["hostname"] = hostname
        self.store.config["cloudflare"]["tunnelName"] = tunnel_name
        if hostname:
            self.store.config["server"]["publicBaseUrl"] = f"https://{hostname}"
            self.query_one("#cfg_server_public_base_url", Input).value = f"https://{hostname}"
        if persist and self.store.editable:
            save_config_store(self.store)
        return hostname, tunnel_name

    def sync_cloudflare_hostname_for_pairing(self, persist: bool = False) -> str:
        public_url = cloudflare_public_url(self.query_one("#cf_hostname", Input).value)
        if not public_url:
            return ""

        if self.store.config["server"].get("publicBaseUrl") != public_url:
            self.store.config["server"]["publicBaseUrl"] = public_url
            self.query_one("#cfg_server_public_base_url", Input).value = public_url
            self.store.config.setdefault("cloudflare", {})
            self.store.config["cloudflare"]["hostname"] = normalize_cloudflare_hostname(public_url)
            self.store.config["cloudflare"]["tunnelName"] = normalized_tunnel_name(
                self.query_one("#cf_tunnel_name", Input).value
            )
            if persist and self.store.editable:
                save_config_store(self.store)
            self.refresh_dashboard()

        return public_url

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id != "cf_hostname":
            return

        public_url = self.sync_cloudflare_hostname_for_pairing(persist=False)
        if public_url:
            self.set_status(f"Pairing URL set to {public_url}")

    def refresh_dashboard(self) -> None:
        config = self.store.config
        base_url = bridge_url(config)
        external_url = advertised_bridge_url(config)
        sqlite_path = sqlite_path_for(config)
        devices = read_devices(sqlite_path)
        session_count = read_session_count(sqlite_path)
        health, health_detail = get_bridge_health(base_url)
        bridge_payload, _ = get_bridge_health_payload(base_url)
        assistant_info = bridge_payload.get("assistant", {}) if isinstance(bridge_payload, dict) else {}
        bridge_info = bridge_payload.get("bridge", {}) if isinstance(bridge_payload, dict) else {}
        cloudflare_info = bridge_payload.get("cloudflare", {}) if isinstance(bridge_payload, dict) else {}
        opencode_health, _opencode_detail, opencode_version = get_opencode_health(config)
        assistant_mode = normalize_assistant_mode(config.get("assistant", {}))

        hero = (
            "dexyd\n\n"
            f"{health.upper()} · {external_url}\n"
            f"{health_detail}"
        )
        bridge = (
            "BRIDGE\n\n"
            f"{config['server']['host']}:{config['server']['port']}\n"
            f"Log: {config['server']['logLevel']}\n"
            f"Ready: {health}\n"
            f"Version: {read_package_version()}\n"
            f"Advertised: {bridge_info.get('advertisedBaseUrl') or external_url}"
        )
        storage = (
            "DATA\n\n"
            f"Sessions: {session_count}\n"
            f"OpenCode DB: {'ready' if opencode_sqlite_path_for(config).exists() else 'missing'}\n"
            f"Devices: {len(devices)}\n"
            f"DB: {'ready' if sqlite_path.exists() else 'new'}"
        )
        security = (
            "SECURITY\n\n"
            f"Access: {config['auth']['accessTokenTtlSeconds']}s\n"
            f"Refresh: {config['auth']['refreshTokenTtlSeconds']}s\n"
            f"Key: {'set' if config['auth']['signingKey'] else 'missing'}"
        )
        assistant = (
            "ASSISTANT\n\n"
            f"Default: {assistant_mode.upper()}\n"
            f"Codex harness: {assistant_info.get('codexHarnessMode') or config['codex']['harness']['mode']}\n"
            f"OpenCode: {assistant_info.get('opencodeStatus') or opencode_health}"
            f"{f' · {opencode_version}' if opencode_version else ''}\n"
            f"Tunnel: {'configured' if cloudflare_info.get('configured') else 'not configured'}"
        )
        next_steps = (
            "ACTIONS\n\n"
            "Connection → service, tunnel, QR\n"
            "Work → switch Codex/OpenCode\n"
            "Updates → check latest release"
        )
        self.query_one("#dashboard_hero", Static).update(hero)
        self.query_one("#bridge_card", Static).update(bridge)
        self.query_one("#storage_card", Static).update(storage)
        self.query_one("#security_card", Static).update(security)
        self.query_one("#assistant_card", Static).update(assistant)
        self.query_one("#next_steps_card", Static).update(next_steps)

    def refresh_updates(self) -> None:
        self.query_one("#update_output", Static).update(
            format_update_info(
                self.update_info,
                busy=self.update_busy,
                log=self.update_log_text,
                relaunch_pending=self.update_relaunch_pending,
            )
        )

    def append_update_output(self, message: str) -> None:
        if threading.current_thread() is not threading.main_thread():
            self.call_from_thread(self.append_update_output, message)
            return

        line = message.strip()
        if not line:
            return
        timestamp = time.strftime("%H:%M:%S")
        self.update_log_text = f"{self.update_log_text}\n\n[{timestamp}] {line}".strip()
        if len(self.update_log_text) > 12000:
            self.update_log_text = self.update_log_text[-12000:]
        self.refresh_updates()
        self.set_status(line.splitlines()[0])

    def run_update_task(self, label: str, action: Callable[[], Any]) -> None:
        if self.update_busy:
            self.set_status("Update task already running")
            return

        self.update_busy = True
        self.append_update_output(f"{label} started.")
        self.refresh_updates()

        def worker() -> None:
            try:
                result = action()
                if result:
                    self.append_update_output(str(result))
            except Exception as exc:  # pragma: no cover - interactive guard
                self.append_update_output(f"Error: {exc}")
            finally:
                self.call_from_thread(self.finish_update_task, label)

        threading.Thread(target=worker, name=f"dexyd-{label.lower().replace(' ', '-')}", daemon=True).start()

    def finish_update_task(self, label: str) -> None:
        self.update_busy = False
        self.refresh_updates()
        self.refresh_dashboard()
        self.set_status(f"{label} finished")

    def check_updates(self) -> str:
        self.update_info = latest_release_info()
        self.call_from_thread(self.refresh_updates)
        return (
            f"Latest release: {self.update_info.latest_version}. "
            f"{'Update available.' if self.update_info.update_available else 'Already up to date.'}"
        )

    def install_update(self) -> str:
        if self.update_info is None:
            self.update_info = latest_release_info()
            self.call_from_thread(self.refresh_updates)
        result = install_latest_bridge_update(app_root(), self.update_info, log=self.append_update_output)
        self.call_from_thread(self.schedule_relaunch_after_update)
        return result

    def schedule_relaunch_after_update(self) -> None:
        self.update_relaunch_pending = True
        self.append_update_output("Update verified. Relaunching through installed dexyd in 2 seconds…")
        self.refresh_updates()
        timer = threading.Timer(2.0, self.perform_update_relaunch)
        timer.daemon = True
        timer.start()

    def perform_update_relaunch(self) -> None:
        try:
            relaunch_installed_tui(self.store.path)
        except Exception as exc:  # pragma: no cover - process replacement guard
            self.call_from_thread(self.append_update_output, f"Relaunch failed: {exc}. Run `dexyd --tui` manually.")

    def refresh_settings_summary(self) -> None:
        harness = self.store.config["codex"]["harness"]
        opencode_health, opencode_detail, opencode_version = get_opencode_health(self.store.config)
        summary = (
            "CONFIG\n\n"
            f"{self.store.path}\n"
            f"{self.store.format} · {'editable' if self.store.editable else 'read-only'}\n\n"
            "LAUNCHER\n\n"
            f"assistant default: {normalize_assistant_mode(self.store.config.get('assistant', {})).upper()}\n"
            f"{self.store.config['codex']['runtimePath']} · {harness['mode']}\n"
            f"permissions: {self.store.config['codex'].get('permissionMode', DEFAULT_CONFIG['codex']['permissionMode'])}\n"
            f"{harness['command']} {shlex.join([str(arg) for arg in harness.get('args', [])])}\n\n"
            "OPENCODE\n\n"
            f"{'enabled' if self.store.config['opencode'].get('enabled') else 'disabled'} · {opencode_health}"
            f"{f' · {opencode_version}' if opencode_version else ''}\n"
            f"{opencode_server_base_url(self.store.config)}\n"
            f"{opencode_detail}"
        )
        self.query_one("#settings_summary", Static).update(summary)

    def refresh_assistant_status(self) -> None:
        mode = normalize_assistant_mode(self.store.config.get("assistant", {}))
        opencode_health, opencode_detail, opencode_version = get_opencode_health(self.store.config)
        harness = self.store.config["codex"]["harness"]
        status = (
            f"Current default: {mode.upper()}\n"
            f"Codex runtime: {self.store.config['codex']['runtimePath']} · harness {harness['mode']}\n"
            f"OpenCode: {opencode_health}{f' · {opencode_version}' if opencode_version else ''}\n"
            f"OpenCode URL: {opencode_server_base_url(self.store.config)}\n"
            f"{opencode_detail}"
        )
        self.query_one("#assistant_mode_status", Static).update(status)
        self.query_one("#assistant_mode_status_big", Static).update(status)

    def refresh_cloudflare(self) -> None:
        output = cloudflare_status_text(self.store.config)
        if self.cloudflare_busy:
            output += "\n\nTask: running"
        if self.cloudflare_log_text:
            output += f"\n\nRECENT ACTIVITY\n\n{self.cloudflare_log_text}"
        self.query_one("#cloudflare_output", Static).update(output)

    def refresh_bridge_config_status(self) -> None:
        config = self.store.config
        base_url = bridge_url(config)
        public_url = advertised_bridge_url(config)
        health, detail = get_bridge_health(base_url)
        bridge_payload, _payload_detail = get_bridge_health_payload(base_url)
        bridge_meta = bridge_payload.get("bridge", {}) if isinstance(bridge_payload, dict) else {}
        cloudflare_meta = bridge_payload.get("cloudflare", {}) if isinstance(bridge_payload, dict) else {}
        assistant_meta = bridge_payload.get("assistant", {}) if isinstance(bridge_payload, dict) else {}
        opencode_health, _opencode_detail, opencode_version = get_opencode_health(config)
        bridge_active, bridge_enabled = user_service_state("dexyd.service")
        tunnel_active, tunnel_enabled = user_service_state("dexyd-cloudflared.service")
        pid = read_pid(CLOUDFLARE_PID_FILE)
        tunnel_process = "running" if process_is_running(pid) else "stopped"
        config_state = "present" if CLOUDFLARE_CONFIG_FILE.exists() else "missing"
        cloudflared = cloudflared_path()
        legacy_line = ""
        if tunnel_active not in {"inactive", "failed", "unknown"} or tunnel_enabled not in {"disabled", "unknown"}:
            legacy_line = f"\nLegacy separate tunnel service: {tunnel_active} · {tunnel_enabled}"
        self.query_one("#bridge_config_status", Static).update(
            "STATUS\n\n"
            f"{'●' if health in {'ready', 'ok'} else '○'} bridge API: {health} · {base_url}\n"
            f"{'●' if bridge_active == 'active' else '○'} dexyd.service: {bridge_active} · {bridge_enabled}\n"
            f"{'●' if config_state == 'present' else '○'} tunnel config: {config_state}\n"
            f"{'●' if tunnel_process == 'running' else '○'} tunnel process: {tunnel_process}{f' · pid {pid}' if process_is_running(pid) else ''}\n"
            f"{'●' if public_url else '○'} pairing URL: {public_url}\n"
            f"advertised URL: {bridge_meta.get('advertisedBaseUrl') or public_url}\n"
            f"cloudflare: {cloudflare_meta.get('publicUrl') or '(not configured)'} · {cloudflare_meta.get('tunnelName') or config.get('cloudflare', {}).get('tunnelName') or 'dexyd'}\n"
            f"assistant: codex/{assistant_meta.get('codexHarnessMode') or config['codex']['harness']['mode']} · opencode/{assistant_meta.get('opencodeStatus') or opencode_health}{f' · {opencode_version}' if opencode_version else ''}\n"
            f"cloudflared: {'installed' if cloudflared else 'missing'}{f' · {cloudflared}' if cloudflared else ''}\n"
            f"health detail: {detail}"
            f"{legacy_line}\n"
            "Service model: dexyd.service starts bridge and tunnel when tunnel config exists."
        )

    def refresh_projects(self) -> None:
        self.query_one("#project_output", Static).update(project_list_text(self.store.config))

    def append_cloudflare_output(self, message: str) -> None:
        if threading.current_thread() is not threading.main_thread():
            self.call_from_thread(self.append_cloudflare_output, message)
            return

        line = message.strip()
        if not line:
            return
        timestamp = time.strftime("%H:%M:%S")
        self.cloudflare_log_text = f"{self.cloudflare_log_text}\n\n[{timestamp}] {line}".strip()
        blocks = [block for block in self.cloudflare_log_text.split("\n\n") if block.strip()]
        if len(blocks) > 40:
            self.cloudflare_log_text = "\n\n".join(blocks[-40:])
        if len(self.cloudflare_log_text) > 8000:
            self.cloudflare_log_text = self.cloudflare_log_text[-8000:]
        self.refresh_cloudflare()
        self.set_status(line.splitlines()[0])

    def run_cloudflare_task(
        self,
        label: str,
        action: Callable[[], Any],
        on_duplicate_confirmed: Callable[[], Any] | None = None,
    ) -> None:
        if self.cloudflare_busy:
            self.set_status("Cloudflare task already running")
            return

        self.cloudflare_busy = True
        self.append_cloudflare_output(f"{label} started.")
        self.refresh_cloudflare()

        def worker() -> None:
            try:
                result = action()
                if result:
                    self.append_cloudflare_output(str(result))
            except CloudflareDuplicateError as exc:
                if on_duplicate_confirmed is None:
                    self.append_cloudflare_output(f"Duplicate: {exc}")
                else:
                    self.call_from_thread(self.prompt_cloudflare_overwrite, exc, label, on_duplicate_confirmed)
            except Exception as exc:  # pragma: no cover - interactive guard
                self.append_cloudflare_output(f"Error: {exc}")
            finally:
                self.call_from_thread(self.finish_cloudflare_task, label)

        threading.Thread(target=worker, name=f"dexyd-{label.lower().replace(' ', '-')}", daemon=True).start()

    def prompt_cloudflare_overwrite(
        self,
        error: CloudflareDuplicateError,
        label: str,
        on_confirmed: Callable[[], Any],
    ) -> None:
        message = (
            f"{error}\n\n"
            f"Tunnel name: {error.tunnel_name}\n"
            f"Hostname: {error.hostname}\n\n"
            "Overwrite will replace the conflicting Cloudflare tunnel or DNS route for this hostname."
        )

        def callback(confirmed: bool) -> None:
            if confirmed:
                self.append_cloudflare_output(f"Overwrite confirmed for {error.conflict}: {error.tunnel_name} / {error.hostname}")
                self.run_cloudflare_task(f"{label} overwrite", on_confirmed)
            else:
                self.append_cloudflare_output("Overwrite cancelled. Choose another Cloudflare tunnel name or hostname.")

        self.push_screen(ConfirmScreen("Cloudflare duplicate detected", message), callback)

    def finish_cloudflare_task(self, label: str) -> None:
        self.cloudflare_busy = False
        self.refresh_cloudflare()
        self.set_status(f"{label} finished")

    def save_public_base_url(self, url: str) -> None:
        normalized = normalize_public_base_url(url)
        if not normalized:
            raise RuntimeError(f"Invalid public URL from Cloudflare: {url}")
        self.store.config["server"]["publicBaseUrl"] = normalized
        hostname = normalize_cloudflare_hostname(normalized)
        if hostname:
            self.store.config.setdefault("cloudflare", {})
            self.store.config["cloudflare"]["hostname"] = hostname
        save_config_store(self.store)
        if threading.current_thread() is threading.main_thread():
            self.apply_saved_public_base_url(normalized)
        else:
            self.call_from_thread(self.apply_saved_public_base_url, normalized)

    def apply_saved_public_base_url(self, normalized: str) -> None:
        self.query_one("#cfg_server_public_base_url", Input).value = normalized
        self.refresh_dashboard()
        self.refresh_settings_summary()
        self.refresh_cloudflare()
        self.refresh_bridge_config_status()

    def build_pairing_output(self, pairing_base_url: str, expires_in_seconds: int) -> tuple[str, str]:
        pairing = start_pairing(bridge_url(self.store.config), pairing_base_url, expires_in_seconds)
        uri = build_compact_pairing_uri(pairing)
        qr = render_terminal_qr(uri)
        output = (
            f"Pairing ready\n"
            f"ID:      {pairing.get('pairingId', 'unknown')}\n"
            f"Bridge:  {pairing_base_url}\n"
            f"Expires: {pairing.get('expiresAt', 'unknown')}\n\n"
            "Scan this with the mobile Pairing screen. This QR was generated after the public tunnel URL was selected.\n\n"
            f"{qr}\n\n"
            f"Compact URI:\n{uri}"
        )
        return uri, output

    def publish_pairing_output(self, uri: str, output: str, status: str = "Pairing QR generated") -> None:
        self.last_pairing_uri = uri
        self.query_one("#qr_output", Static).update(output)
        self.set_status(status)

    def ensure_cloudflared(self) -> str:
        path = cloudflared_path()
        if path:
            return path
        self.append_cloudflare_output("cloudflared is missing; installing to ~/.local/bin/cloudflared ...")
        path = install_cloudflared_user_local()
        self.append_cloudflare_output(f"Installed cloudflared: {cloudflared_version(path)}")
        return path

    def cloudflare_login(self, path: str) -> None:
        if cloudflared_cert_path().exists():
            self.append_cloudflare_output(f"Cloudflare login already present: {cloudflared_cert_path()}")
            return

        self.append_cloudflare_output(
            "Starting Cloudflare login. A browser window should open. If it does not, copy the URL printed below."
        )
        process = subprocess.Popen(
            [path, "tunnel", "login"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        deadline = time.time() + 300
        output_lines: list[str] = []
        assert process.stdout is not None
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        while process.poll() is None and time.time() < deadline:
            for key, _events in selector.select(timeout=0.2):
                line = key.fileobj.readline()
                if line:
                    output_lines.append(line.rstrip())
                    self.append_cloudflare_output(line.rstrip())
        selector.close()

        if process.poll() is None:
            process.terminate()
            raise RuntimeError("Cloudflare login timed out after 5 minutes.")

        remainder = process.stdout.read()
        if remainder:
            output_lines.append(remainder.rstrip())
        if process.returncode != 0:
            raise RuntimeError("Cloudflare login failed:\n" + "\n".join(output_lines[-12:]))
        self.append_cloudflare_output("Cloudflare login complete.")

    def configure_named_cloudflare_tunnel(self, hostname: str, tunnel_name: str, overwrite: bool = False) -> CloudflareTunnelSetup:
        path = self.ensure_cloudflared()
        hostname = normalize_cloudflare_hostname(hostname)
        if not hostname:
            raise RuntimeError("Enter a Cloudflare-managed public hostname, e.g. dexyd.example.com")
        tunnel_name = normalized_tunnel_name(tunnel_name)

        self.cloudflare_login(path)
        origin = local_cloudflare_origin(self.store.config)
        setup = ensure_available_cloudflare_tunnel(path, tunnel_name, hostname, origin, overwrite=overwrite)
        if setup.route_output:
            self.append_cloudflare_output(setup.route_output)
        public_url = setup.public_url
        self.save_public_base_url(public_url)
        self.store.config.setdefault("cloudflare", {})
        self.store.config["cloudflare"]["hostname"] = setup.hostname
        self.store.config["cloudflare"]["tunnelName"] = setup.tunnel_name
        save_config_store(self.store)
        self.append_cloudflare_output(
            f"Tunnel configured: {public_url}\n"
            f"Tunnel: {setup.tunnel_name} ({setup.tunnel_id})\n"
            f"Origin: {origin}\n"
            f"Config: {setup.config_path}\n"
            f"Metadata: {CLOUDFLARE_METADATA_FILE}"
        )
        return setup

    def start_named_cloudflare_tunnel(self, hostname: str, tunnel_name: str, pairing_expiry: int, overwrite: bool = False) -> None:
        ensure_bridge_origin_ready(self.store.config)
        hostname = normalize_cloudflare_hostname(hostname)
        tunnel_name = normalized_tunnel_name(tunnel_name)
        metadata = read_cloudflare_metadata()
        config_matches_request = (
            CLOUDFLARE_CONFIG_FILE.exists()
            and str(metadata.get("tunnelName") or metadata.get("requestedTunnelName") or "") == tunnel_name
            and normalize_cloudflare_hostname(metadata.get("hostname") or "") == hostname
        )
        if not config_matches_request:
            setup = self.configure_named_cloudflare_tunnel(hostname, tunnel_name, overwrite=overwrite)
            metadata = read_cloudflare_metadata()
        else:
            setup = None

        stop_pid(read_pid(CLOUDFLARE_PID_FILE))
        public_url = normalize_public_base_url(metadata.get("publicUrl") or self.store.config["server"].get("publicBaseUrl"))
        if not public_url:
            public_url = cloudflare_public_url(hostname)
        if not public_url:
            raise RuntimeError("Tunnel public URL is missing. Configure the Cloudflare tunnel in Advanced first.")
        self.save_public_base_url(public_url)
        service_message = install_user_service(self.store.path)
        restart_message = restart_connection_user_service()
        service_active, _service_enabled = user_service_state("dexyd.service")
        pid: int | None = None
        if service_active != "active":
            path = self.ensure_cloudflared()
            pid = start_cloudflared_process([path, "--config", str(CLOUDFLARE_CONFIG_FILE), "tunnel", "run"])
        self.append_cloudflare_output(
            f"Named tunnel running: {public_url}\n"
            f"Tunnel: {metadata.get('tunnelName') or (setup.tunnel_name if setup else 'configured')}"
            f"{f' ({metadata.get('tunnelId')})' if metadata.get('tunnelId') else ''}\n"
            f"Origin: {local_cloudflare_origin(self.store.config)}\n"
            f"Config: {CLOUDFLARE_CONFIG_FILE}\n"
            f"Metadata: {CLOUDFLARE_METADATA_FILE}\n"
            f"Service: {service_message}\n"
            f"Restart: {restart_message}\n"
            f"Temporary PID: {pid if pid else 'not needed; managed by dexyd.service'}\n"
            "Waiting for public tunnel health before generating the pairing QR..."
        )
        ready, detail = wait_for_bridge_ready(public_url, timeout_seconds=90, pid=pid)
        if not ready:
            raise RuntimeError(detail)

        self.append_cloudflare_output(f"Public tunnel is ready: {detail}\nGenerating a fresh pairing QR for {public_url}...")
        uri, output = self.build_pairing_output(public_url, pairing_expiry)
        self.call_from_thread(
            self.publish_pairing_output,
            uri,
            output,
            "Tunnel ready. Pairing QR generated.",
        )

    def refresh_sessions(self) -> None:
        sessions = read_visible_sessions(self.store.config)
        if not sessions:
            self.query_one("#session_output", Static).update("No sessions yet. Create one from the mobile Chat or Sessions screen.")
            self.query_one("#diff_output", Static).update("No session diff available.")
            return

        rows = []
        for index, session in enumerate(sessions, start=1):
            title = session.title or Path(session.workspace_path).name or session.id[:8]
            rows.append(
                f"{index}. {session.status.upper()}  [{session.source}] {title}\n"
                f"   project: {session.workspace_path}\n"
                f"   id: {session.id}\n"
                f"   profile: {session.profile}  updated: {session.updated_at}"
                f"{f'  agent: {session.agent}' if session.agent else ''}"
                f"{f'  model: {session.model}' if session.model else ''}"
            )
        self.query_one("#session_output", Static).update("\n\n".join(rows))
        chat_input = self.query_one("#chat_session_id", Input)
        if not chat_input.value.strip():
            chat_input.value = sessions[0].id
        self.refresh_chat_output()
        self.query_one("#diff_output", Static).update("LATEST SESSION DIFF\n\n" + git_diff_summary(sessions[0].workspace_path))

    def refresh_chat_output(self) -> None:
        session_id = self.query_one("#chat_session_id", Input).value.strip()
        messages = read_any_chat_messages(self.store.config, session_id)
        if not session_id:
            self.query_one("#chat_output", Static).update("CHAT\n\nEnter a session id or refresh sessions to auto-select the newest session.")
            return
        if not messages:
            self.query_one("#chat_output", Static).update(f"CHAT\n\nNo chat messages found for {session_id}.")
            return
        self.query_one("#chat_output", Static).update("CHAT\n\n" + "\n\n---\n\n".join(messages[-30:]))

    def open_dexyd_help_session(self) -> None:
        help_dir = ensure_dexyd_help_workspace(self.store.config)
        sqlite_path = sqlite_path_for(self.store.config)
        now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
        session_id = "dexyd-help"
        if sqlite_path.exists():
            connection = sqlite3.connect(str(sqlite_path))
            try:
                cursor = connection.cursor()
                cursor.execute("PRAGMA table_info(sessions)")
                columns = {str(row[1]) for row in cursor.fetchall()}
                if "title" in columns:
                    cursor.execute(
                        """
                        INSERT INTO sessions (id, status, workspace_path, created_at, updated_at, profile, title)
                        VALUES (?, 'idle', ?, ?, ?, 'dexyd-help', 'dexyd help')
                        ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, workspace_path=excluded.workspace_path
                        """,
                        (session_id, str(help_dir), now, now),
                    )
                else:
                    cursor.execute(
                        """
                        INSERT INTO sessions (id, status, workspace_path, created_at, updated_at, profile)
                        VALUES (?, 'idle', ?, ?, ?, 'dexyd-help')
                        ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, workspace_path=excluded.workspace_path
                        """,
                        (session_id, str(help_dir), now, now),
                    )
                connection.commit()
            finally:
                connection.close()
        self.query_one("#chat_session_id", Input).value = session_id
        self.refresh_sessions()
        self.set_status(f"Dexyd help workspace ready: {help_dir}")

    def refresh_devices(self) -> None:
        sqlite_path = sqlite_path_for(self.store.config)
        devices = read_devices(sqlite_path)
        if not devices:
            self.query_one("#device_output", Static).update(
                "No paired devices yet.\n\nGenerate a QR in Pairing, then scan it from the mobile app."
            )
            return

        rows = []
        for index, device in enumerate(devices, start=1):
            rows.append(
                f"{index}. {device.label}\n"
                f"   id:        {device.id}\n"
                f"   trust:     {device.trust_state}\n"
                f"   created:   {device.created_at}\n"
                f"   last seen: {device.last_seen_at or 'never'}"
            )
        self.query_one("#device_output", Static).update("\n\n".join(rows))

    def _save_settings(self) -> None:
        config = self.store.config
        host = self.query_one("#cfg_server_host", Input).value.strip() or config["server"]["host"]
        port = parse_int(self.query_one("#cfg_server_port", Input).value, config["server"]["port"], 1)
        log_level = self.query_one("#cfg_server_log_level", Input).value.strip().lower() or config["server"]["logLevel"]
        public_base_url_raw = self.query_one("#cfg_server_public_base_url", Input).value
        public_base_url = normalize_public_base_url(public_base_url_raw)
        cloudflare_hostname = normalize_cloudflare_hostname(self.query_one("#cf_hostname", Input).value)
        cloudflare_tunnel_name = normalized_tunnel_name(self.query_one("#cf_tunnel_name", Input).value)

        if port > 65535:
            raise RuntimeError("Server port must be between 1 and 65535")
        if log_level not in LOG_LEVELS:
            raise RuntimeError("Log level must be one of: fatal, error, warn, info, debug, trace")
        if public_base_url_raw.strip() and not public_base_url:
            raise RuntimeError("Public bridge URL must start with http:// or https:// and include a host")

        access_ttl = parse_int(self.query_one("#cfg_auth_access_ttl", Input).value, config["auth"]["accessTokenTtlSeconds"], 30)
        refresh_ttl = parse_int(self.query_one("#cfg_auth_refresh_ttl", Input).value, config["auth"]["refreshTokenTtlSeconds"], 60)
        signing_key = self.query_one("#cfg_auth_signing_key", Input).value.strip() or config["auth"]["signingKey"]
        if len(signing_key) < 16:
            raise RuntimeError("Signing key must be at least 16 characters")

        replay = parse_int(self.query_one("#cfg_stream_replay", Input).value, config["stream"]["replayWindowSeconds"], 10)
        idle = parse_int(self.query_one("#cfg_stream_idle", Input).value, config["stream"]["heartbeatIdleSeconds"], 5)

        codex_runtime = self.query_one("#cfg_codex_runtime_path", Input).value.strip() or config["codex"]["runtimePath"]
        codex_workspace = self.query_one("#cfg_codex_workspace_root", Input).value.strip() or config["codex"]["workspaceRoot"]
        permission_mode = self.query_one("#cfg_codex_permission_mode", Input).value.strip() or config["codex"].get("permissionMode", DEFAULT_CONFIG["codex"]["permissionMode"])
        harness_mode = self.query_one("#cfg_codex_harness_mode", Input).value.strip().lower() or config["codex"]["harness"]["mode"]
        harness_command = self.query_one("#cfg_codex_harness_command", Input).value.strip() or config["codex"]["harness"]["command"]
        harness_args_raw = self.query_one("#cfg_codex_harness_args", Input).value.strip()
        assistant_mode = normalize_assistant_mode(self.query_one("#cfg_assistant_mode", Input).value)
        opencode_enabled = parse_bool(self.query_one("#cfg_opencode_enabled", Input).value, config["opencode"].get("enabled", True))
        opencode_runtime = self.query_one("#cfg_opencode_runtime_path", Input).value.strip() or config["opencode"]["runtimePath"]
        opencode_data_dir = self.query_one("#cfg_opencode_data_dir", Input).value.strip() or config["opencode"]["dataDir"]
        opencode_host = self.query_one("#cfg_opencode_server_host", Input).value.strip() or config["opencode"]["server"]["host"]
        opencode_port = parse_int(self.query_one("#cfg_opencode_server_port", Input).value, config["opencode"]["server"]["port"], 1)
        opencode_agent = self.query_one("#cfg_opencode_default_agent", Input).value.strip() or config["opencode"]["defaultAgent"]
        opencode_model = self.query_one("#cfg_opencode_default_model", Input).value.strip()
        opencode_permission_mode = self.query_one("#cfg_opencode_permission_mode", Input).value.strip() or config["opencode"].get("permissionMode", DEFAULT_CONFIG["opencode"]["permissionMode"])
        opencode_password = self.query_one("#cfg_opencode_server_password", Input).value
        if permission_mode not in PERMISSION_MODES:
            raise RuntimeError("Permission mode must be one of: inherit, read-only, workspace-write, danger-full-access, bypass")
        if harness_mode not in HARNESS_MODES:
            raise RuntimeError("Harness mode must be one of: direct, omx, custom")
        if opencode_permission_mode not in PERMISSION_MODES:
            raise RuntimeError("OpenCode permission mode must be one of: inherit, read-only, workspace-write, danger-full-access, bypass")
        if opencode_port > 65535:
            raise RuntimeError("OpenCode server port must be between 1 and 65535")
        if harness_mode != "direct" and not harness_command:
            raise RuntimeError("Harness command is required when harness mode is omx or custom")
        try:
            harness_args = shlex.split(harness_args_raw) if harness_args_raw else []
        except ValueError as exc:
            raise RuntimeError(f"Could not parse harness args: {exc}") from exc
        if any("\0" in arg for arg in harness_args):
            raise RuntimeError("Harness args cannot contain NUL bytes")

        config["server"]["host"] = host
        config["server"]["port"] = port
        config["server"]["logLevel"] = log_level
        config["server"]["publicBaseUrl"] = public_base_url
        if cloudflare_hostname:
            config["server"]["publicBaseUrl"] = f"https://{cloudflare_hostname}"
            self.query_one("#cfg_server_public_base_url", Input).value = config["server"]["publicBaseUrl"]
        config.setdefault("cloudflare", {})
        config["cloudflare"]["hostname"] = cloudflare_hostname
        config["cloudflare"]["tunnelName"] = cloudflare_tunnel_name
        config["auth"]["accessTokenTtlSeconds"] = access_ttl
        config["auth"]["refreshTokenTtlSeconds"] = refresh_ttl
        config["auth"]["signingKey"] = signing_key
        config["stream"]["replayWindowSeconds"] = replay
        config["stream"]["heartbeatIdleSeconds"] = idle
        config["codex"]["runtimePath"] = codex_runtime
        config["codex"]["workspaceRoot"] = codex_workspace
        config["codex"]["permissionMode"] = permission_mode
        config["codex"]["harness"] = {
            "mode": harness_mode,
            "command": harness_command,
            "args": harness_args,
        }
        config.setdefault("assistant", {})
        config["assistant"]["mode"] = assistant_mode
        config["assistant"]["defaultMode"] = assistant_mode
        config.setdefault("opencode", copy.deepcopy(DEFAULT_CONFIG["opencode"]))
        config["opencode"]["enabled"] = opencode_enabled
        config["opencode"]["runtimePath"] = opencode_runtime
        config["opencode"]["dataDir"] = opencode_data_dir
        config["opencode"]["permissionMode"] = opencode_permission_mode
        config["opencode"].setdefault("server", copy.deepcopy(DEFAULT_CONFIG["opencode"]["server"]))
        config["opencode"]["server"]["host"] = opencode_host
        config["opencode"]["server"]["port"] = opencode_port
        config["opencode"]["server"]["password"] = opencode_password
        config["opencode"]["defaultAgent"] = opencode_agent
        config["opencode"]["defaultModel"] = opencode_model
        save_config_store(self.store)

    def set_assistant_mode(self, mode: str) -> None:
        normalized = normalize_assistant_mode(mode)
        self.store.config.setdefault("assistant", {})
        self.store.config["assistant"]["mode"] = normalized
        self.store.config["assistant"]["defaultMode"] = normalized
        if normalized == "opencode":
            self.store.config.setdefault("opencode", copy.deepcopy(DEFAULT_CONFIG["opencode"]))
            self.store.config["opencode"]["enabled"] = True
            self.query_one("#cfg_opencode_enabled", Input).value = "true"
        self.query_one("#cfg_assistant_mode", Input).value = normalized
        save_config_store(self.store)
        self.refresh_dashboard()
        self.refresh_settings_summary()
        self.refresh_assistant_status()
        self.refresh_bridge_config_status()
        self.set_status(f"Assistant default switched to {normalized.upper()}. Restart bridge/service if runtime config changed.")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        button_id = event.button.id or ""
        try:
            if button_id in {"refresh_dashboard", "refresh_devices", "refresh_sessions", "refresh_projects", "bridge_config_refresh"}:
                self.refresh_all()
                self.set_status("Refreshed")
            elif button_id == "check_updates":
                self.run_update_task("Check updates", self.check_updates)
            elif button_id == "install_update":
                self.run_update_task("Install update", self.install_update)
            elif button_id == "reload_config":
                self.reload_config()
                self.set_status("Config reloaded")
            elif button_id == "install_service":
                self.set_status(install_user_service(self.store.path))
                self.refresh_bridge_config_status()
                self.refresh_cloudflare()
            elif button_id == "restart_connection_service":
                self.set_status(restart_connection_user_service())
                self.refresh_bridge_config_status()
                self.refresh_cloudflare()
            elif button_id == "stop_connection_service":
                self.set_status(stop_connection_user_service())
                self.refresh_bridge_config_status()
                self.refresh_cloudflare()
            elif button_id == "show_chat":
                self.refresh_chat_output()
                self.set_status("Chat refreshed")
            elif button_id == "create_project":
                path = create_project_dir(self.store.config, self.query_one("#project_path", Input).value)
                self.query_one("#project_path", Input).value = str(path)
                self.refresh_projects()
                self.set_status(f"Project ready: {path}")
            elif button_id == "create_session":
                project = create_project_dir(self.store.config, self.query_one("#project_path", Input).value)
                title = self.query_one("#session_title", Input).value
                assistant_mode = normalize_assistant_mode(self.store.config.get("assistant", {}))
                if assistant_mode == "opencode":
                    session_id = create_opencode_session(self.store.config, title or project.name)
                else:
                    session_id = create_codex_session(self.store.config, str(project), title)
                self.query_one("#chat_session_id", Input).value = session_id
                self.refresh_sessions()
                self.set_status(f"{assistant_mode.upper()} session created: {session_id}")
            elif button_id == "set_session_status":
                session_id = self.query_one("#chat_session_id", Input).value.strip()
                status = self.query_one("#session_status", Input).value.strip().lower()
                changed = set_local_session_status(sqlite_path_for(self.store.config), session_id, status)
                self.refresh_sessions()
                self.set_status(f"Session status {'updated' if changed else 'not found'}: {session_id}")
            elif button_id == "delete_session":
                session_id = self.query_one("#chat_session_id", Input).value.strip()
                deleted, hidden = delete_or_hide_session(sqlite_path_for(self.store.config), session_id)
                self.refresh_sessions()
                self.set_status(f"Session {'deleted' if deleted else 'hidden'}: {session_id} ({'hidden' if hidden else 'visible'})")
            elif button_id == "open_dexyd_chat":
                self.open_dexyd_help_session()
            elif button_id in {"use_codex_mode", "advanced_use_codex_mode", "assistant_use_codex_mode"}:
                self.set_assistant_mode("codex")
            elif button_id in {"use_opencode_mode", "advanced_use_opencode_mode", "assistant_use_opencode_mode"}:
                self.set_assistant_mode("opencode")
            elif button_id in {"save_settings", "save_connection"}:
                self._save_settings()
                self.refresh_dashboard()
                self.refresh_settings_summary()
                self.refresh_assistant_status()
                self.refresh_bridge_config_status()
                self.set_status("Settings saved. Restart bridge/service to apply runtime changes.")
            elif button_id == "reset_settings":
                self._load_settings_inputs()
                self.set_status("Settings form reset")
            elif button_id == "generate_pairing":
                self.sync_cloudflare_hostname_for_pairing(persist=True)
                pairing_base_url = advertised_bridge_url(self.store.config)
                expiry = parse_int(self.query_one("#pairing_expiry", Input).value, 300, 30)
                uri, output = self.build_pairing_output(pairing_base_url, expiry)
                self.publish_pairing_output(uri, output)
            elif button_id == "clear_qr":
                self.last_pairing_uri = ""
                self.query_one("#qr_output", Static).update("Generate a QR to pair the mobile app.")
                self.set_status("QR output cleared")
            elif button_id == "cf_check":
                self.refresh_cloudflare()
                self.refresh_bridge_config_status()
                self.set_status("Cloudflare status refreshed")
            elif button_id == "cf_install":
                self.run_cloudflare_task("Install cloudflared", self.ensure_cloudflared)
            elif button_id == "cf_login":
                self.run_cloudflare_task("Cloudflare login", lambda: self.cloudflare_login(self.ensure_cloudflared()))
            elif button_id == "cf_configure":
                self._save_settings()
                hostname, tunnel_name = self.save_cloudflare_settings_from_inputs(persist=True)
                self.run_cloudflare_task(
                    "Configure Cloudflare tunnel",
                    lambda: self.configure_named_cloudflare_tunnel(hostname, tunnel_name, overwrite=False),
                    on_duplicate_confirmed=lambda: self.configure_named_cloudflare_tunnel(hostname, tunnel_name, overwrite=True),
                )
            elif button_id == "cf_start_named":
                self._save_settings()
                hostname, tunnel_name = self.save_cloudflare_settings_from_inputs(persist=True)
                pairing_expiry = parse_int(self.query_one("#pairing_expiry", Input).value, 300, 30)
                self.run_cloudflare_task(
                    "Start Cloudflare tunnel",
                    lambda: self.start_named_cloudflare_tunnel(hostname, tunnel_name, pairing_expiry, overwrite=False),
                    on_duplicate_confirmed=lambda: self.start_named_cloudflare_tunnel(hostname, tunnel_name, pairing_expiry, overwrite=True),
                )
            elif button_id == "cf_disable_tunnel":
                self.set_status(disable_cloudflare_tunnel_config())
                self.refresh_cloudflare()
                self.refresh_bridge_config_status()
        except Exception as exc:  # pragma: no cover - interactive guard
            self.set_status(f"Error: {exc}")


def main() -> None:
    config_path = sys.argv[1] if len(sys.argv) > 1 else None
    app = DexydTextualApp(config_path=config_path)
    app.run()


if __name__ == "__main__":
    main()
