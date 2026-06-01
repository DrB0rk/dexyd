# Installation

Dexyd has two pieces:

1. **Bridge** — runs on your computer and talks to Codex/OMX.
2. **Mobile app** — runs on your phone and talks to the bridge after pairing.

The Linux installer is the main supported install path today. Android is the primary mobile target. iOS has an initial React Native target for bring-up on macOS.

## Supported host setups

| Setup | Status | Notes |
| --- | --- | --- |
| Linux bridge host | Primary | Guided installer supports Debian/Ubuntu, Arch, and Fedora-style systems. |
| macOS bridge host | Manual | Bridge can run with Node, but the Linux installer does not manage macOS services. |
| WSL-like shell | Possible | Works best for local bridge tests; phone access needs LAN routing to the WSL host. |
| Android app | Primary | Build/install scripts are included. |
| iOS app | Early | Native project, permissions, icons, and scripts exist; full release flow is not complete. |

## Prerequisites

### Required for the bridge

- Node.js 20 or newer.
- npm.
- Codex CLI installed and authenticated.
- A reachable network path between phone and bridge.

### Recommended for the TUI

- Python 3.
- Textual dependencies installed by the installer.

### Optional integrations

- OMX, if you want sessions launched through `omx exec` instead of direct `codex exec`.
- Caddy, if you want to expose Dexyd through your own HTTPS domain.
- `cloudflared`, if you want the TUI to manage a Cloudflare named tunnel.

## Linux guided install

Install from the published repository with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/drb0rk/dexyd/main/scripts/install.sh | bash
```

The installer pulls Dexyd into `~/.local/share/dexyd` by default. It can:

- clone or update the repository;
- detect common Linux distributions;
- check Git, curl, Node, npm, Python, Java, Android tools, and adb;
- offer distro package installation for missing dependencies;
- create or update `dexyd.config.yaml`;
- generate a strong local signing key;
- set LAN-friendly bridge defaults;
- install bridge dependencies;
- install TUI Python dependencies;
- build the bridge;
- optionally install mobile dependencies and build an Android APK;
- link a `dexyd` command into `~/.local/bin`;
- optionally install and start a user systemd service;
- optionally open the bridge firewall port.

Installer options:

```bash
curl -fsSL https://raw.githubusercontent.com/drb0rk/dexyd/main/scripts/install.sh | bash -s -- --yes
curl -fsSL https://raw.githubusercontent.com/drb0rk/dexyd/main/scripts/install.sh | bash -s -- --dir "$HOME/Apps/dexyd"
curl -fsSL https://raw.githubusercontent.com/drb0rk/dexyd/main/scripts/install.sh | bash -s -- --android --service --firewall
```

Use a custom repository or branch while testing forks:

```bash
curl -fsSL https://raw.githubusercontent.com/drb0rk/dexyd/main/scripts/install.sh | \
  DEXYD_REPO_URL=https://github.com/you/dexyd.git DEXYD_BRANCH=dev bash
```

From an existing checkout, run:

```bash
bash scripts/install.sh --use-current
```

After linking, open Dexyd with:

```bash
dexyd --tui
```

If the command was not linked, run the TUI from the repository root:

```bash
npm run tui
```

## Manual bridge install

Use this when you do not want the guided installer:

```bash
npm install
cp dexyd.config.example.yaml dexyd.config.yaml
npm run build
DEXYD_CONFIG=./dexyd.config.yaml npm run start
```

For an editable local run:

```bash
DEXYD_CONFIG=./dexyd.config.yaml npm run dev
```

The bridge listens on the host/port configured under `server`. The example config uses `0.0.0.0:4242` so a phone on the same LAN can reach it.

## TUI install and use

Open the TUI:

```bash
npm run tui
```

or:

```bash
dexyd --tui
```

Use the TUI to:

- confirm bridge status;
- edit connection settings;
- generate pairing QR codes;
- configure Cloudflare named tunnels;
- view trusted devices;
- inspect sessions;
- install and manage a user systemd service on Linux.

## Linux user service

The TUI can install a user service at:

```text
~/.config/systemd/user/dexyd.service
```

Useful commands after installation:

```bash
systemctl --user status dexyd.service
systemctl --user restart dexyd.service
journalctl --user -u dexyd.service -f
```

If the service starts but the phone cannot connect, check the firewall, host IP, and `server.publicBaseUrl`.

## Android app install

The project includes React Native CLI Android support. For normal use, install a built APK on your phone. For local source builds, install mobile dependencies and use the standard Android project commands.

Build the debug APK:

```bash
cd mobile/dexydMobile/android
./gradlew assembleDebug
```

The APK appears under:

```text
mobile/dexydMobile/android/app/build/outputs/apk/debug/
```

## iOS app install

The iOS target is an early app foundation. iOS builds require macOS and Xcode.

Install CocoaPods dependencies on macOS:

```bash
cd mobile/dexydMobile
bundle install
npm run ios:pods
```

Run on simulator:

```bash
cd mobile/dexydMobile
npm start
npm run ios:sim
```

Run on a physical iPhone:

1. Open `mobile/dexydMobile/ios/dexydMobile.xcodeproj` in Xcode.
2. Select your development team.
3. Trust the Mac on the phone.
4. Start Metro with `npm start`.
5. Run `npm run ios:device`.

## Updates

For a source checkout:

```bash
git pull
npm install
npm run build
cd mobile/dexydMobile && npm install
```

Restart the bridge or user service after updating.

## Uninstall / reset

Stop a user service:

```bash
systemctl --user disable --now dexyd.service
```

Local Dexyd state is normally stored under `.dexyd/` in the repository or configured data directory. Removing that directory removes local bridge DB state, pairings, trusted devices, logs, and plugin data for that install.

The mobile app also has **Settings → Diagnostics → Reset app** to clear local mobile state.
