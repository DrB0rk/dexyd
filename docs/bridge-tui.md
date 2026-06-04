# Bridge and TUI

The bridge is the local service that talks to Codex/OMX and exposes a paired, authenticated API to the mobile app. The TUI is the operator interface for configuring and supervising that bridge.

## Bridge responsibilities

The bridge handles:

- HTTP and WebSocket APIs.
- QR pairing and trusted-device records.
- access/refresh token issuing and revocation.
- SQLite persistence.
- session listing from Dexyd-created sessions and existing Codex/OMX sessions.
- chat submission and output streaming.
- approval/question response forwarding.
- project browsing and creation inside `codex.workspaceRoot`.
- workspace-confined file browsing, file reads, and diffs.
- Codex account/usage status where available.
- audit logs for security-relevant actions.

## Runtime layout

Common installed paths:

| Path | Purpose |
| --- | --- |
| `~/.local/share/dexyd/` | Default XDG application install directory. Respects `XDG_DATA_HOME`. |
| `~/.local/share/dexyd/dexyd.config.yaml` | Installed bridge config. |
| `~/.local/share/dexyd/.dexyd/dexyd.db` | Installed SQLite bridge database. |
| `~/.local/share/dexyd/.dexyd/cloudflared/` | TUI-managed Cloudflare named tunnel logs/config/pid files. |
| `~/.local/bin/dexyd` | Command link created by the installer. |
| `~/.config/systemd/user/dexyd.service` | Optional user service created by the installer/TUI. |

Common source-checkout paths:

| Path | Purpose |
| --- | --- |
| `.dexyd/dexyd.db` | SQLite bridge database. |
| `.dexyd/plugins/` | Local plugin area when plugins are enabled. |
| `.dexyd/cloudflared/` | TUI-managed Cloudflare named tunnel logs/config/pid files. |
| `dexyd.config.yaml` | Local bridge config. Ignored by git. |

## Starting the bridge

Common source checkout command:

```bash
DEXYD_CONFIG=./dexyd.config.yaml npm run start
```

Development command:

```bash
DEXYD_CONFIG=./dexyd.config.yaml npm run dev
```

TUI command:

```bash
npm run tui
```

If the installer linked the command:

```bash
dexyd --tui
```

## TUI sections

### Home

Home is the operational dashboard. It shows bridge/storage/security status and the next useful action. Use it to confirm the bridge is reachable before pairing.

Home stays read-only except for refresh/reload actions. Use **Connection** for bridge service and tunnel setup.

### Connection

Connection is the main setup screen. It keeps all reachability settings together:

- local bridge host/port;
- public bridge URL for domain/Caddy/tunnel use;
- bridge user-service autostart;
- Cloudflare named-tunnel hostname/name;
- cloudflared install/login/setup/start/stop actions;
- tunnel service autostart;
- current bridge and tunnel status.

Connection modes:

- **LAN** — set host to `0.0.0.0`, leave public URL empty, then pair on the LAN URL.
- **Domain/Caddy** — set public URL to your HTTPS reverse proxy URL, save, then pair.
- **Cloudflare named tunnel** — enter the hostname and tunnel name, run setup/start, then pair after the TUI saves the tunnel URL.

The named-tunnel flow can:

1. detect `cloudflared`;
2. install it user-locally on supported Linux systems if missing;
3. run Cloudflare login;
4. create or reuse a named tunnel;
5. route DNS to the selected hostname;
6. write tunnel config;
7. start the tunnel;
8. save `server.publicBaseUrl`;
9. regenerate pairing with the correct URL.

### Pair

Pair creates a short-lived QR payload containing:

- protocol version;
- advertised bridge URL;
- pairing ID;
- one-time challenge;
- expiration time.

Always configure LAN/domain/tunnel first, then generate the QR. Pairing uses the current advertised URL, so old QR codes may point to stale addresses.

### Work

Work shows projects and sessions. It is not meant to replace the mobile chat, but it is useful for confirming the bridge can see local Dexyd sessions and for inspecting recent chat/diff snippets.

### Advanced

Advanced edits less common local bridge configuration:

- workspace root;
- Codex runtime;
- Codex/OMX/custom harness mode;
- token and stream settings.

Use a narrower workspace root when you want the app to see fewer files.

### Devices

Devices lists trusted phones. Revoke a device when:

- a phone is lost;
- a phone is replaced;
- you paired on the wrong network;
- you suspect tokens were copied.

Revocation invalidates that device's refresh tokens.

### Updates

Updates checks GitHub Releases from inside the TUI. It shows:

- installed bridge/TUI version;
- latest release tag;
- whether an update is available;
- release page URL;
- attached Android APK name and URL when present.

**Install bridge update** downloads the official installer and reruns it against the current installed Dexyd app directory. It preserves `dexyd.config.yaml` and `.dexyd` data, reinstalls dependencies, rebuilds the bridge, and restarts the user service when enabled. Restart the TUI after updating so the running interface uses the new code.

For safety, the TUI refuses to self-update a development checkout outside the installed app directory. Use git and the release workflow for development trees.

### Help

Help contains quick reminders for commands and common flows.

## User service

The TUI can create a user-level systemd unit. After installation:

```bash
systemctl --user status dexyd.service
systemctl --user restart dexyd.service
journalctl --user -u dexyd.service -f
```

If user services do not start after login, enable lingering if appropriate for your system:

```bash
loginctl enable-linger "$USER"
```

## Firewall and LAN checks

`4242` is the bridge port. If a phone cannot reach the bridge over LAN, allow TCP `4242` in your OS firewall or router firewall. `8081` is only needed for React Native development builds that load JavaScript from Metro. Normal installed app use only needs the bridge endpoint.

## Pairing URL rules

Dexyd chooses the pairing URL in this order:

1. `server.publicBaseUrl`, if set.
2. detected LAN IPv4 address when listening on `0.0.0.0`.
3. configured host and port.

If the phone connects to the wrong address, update the connection setting in the TUI and generate a new QR.

## Logs and diagnostics

Bridge logs are printed to stdout/stderr or visible through the user service journal. TUI-managed Cloudflare logs live under `.dexyd/cloudflared/`.

When debugging a problem, collect:

- bridge startup logs;
- `dexyd.config.yaml` with secrets redacted;
- TUI status text;
- mobile error history from Settings;
- whether LAN/domain/tunnel is being used.
