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
curl -fsSL https://raw.githubusercontent.com/DrB0rk/dexyd/main/scripts/install.sh | bash
```

The installer puts Dexyd in the XDG app data directory, normally `~/.local/share/dexyd`. It can:

- clone or update the repository;
- clean or replace older Dexyd service and command links;
- detect common Linux distributions;
- check Git, curl, Node, npm, and Python;
- install common missing distro packages when a supported package manager is available;
- create or update `dexyd.config.yaml`;
- generate a strong local signing key;
- set LAN-friendly bridge defaults and use your home directory as the workspace root;
- install bridge dependencies;
- install TUI Python dependencies;
- build the bridge;
- link a `dexyd` command into `~/.local/bin`;
- verify that the command, build output, and TUI virtualenv point at the installed app directory;
- install or restart a user systemd service when user systemd is available;
- optionally open the bridge firewall port when `--firewall` is passed.

The installer is only for the bridge and TUI. It does not install mobile dependencies, build an Android APK, or touch a connected phone.

Installer options:

```bash
curl -fsSL https://raw.githubusercontent.com/DrB0rk/dexyd/main/scripts/install.sh | bash -s -- --yes
curl -fsSL https://raw.githubusercontent.com/DrB0rk/dexyd/main/scripts/install.sh | bash -s -- --dir "$HOME/Apps/dexyd"
curl -fsSL https://raw.githubusercontent.com/DrB0rk/dexyd/main/scripts/install.sh | bash -s -- --firewall
curl -fsSL https://raw.githubusercontent.com/DrB0rk/dexyd/main/scripts/install.sh | bash -s -- --no-service
curl -fsSL https://raw.githubusercontent.com/DrB0rk/dexyd/main/scripts/install.sh | bash -s -- --clean
```

`--yes` is accepted for compatibility with older commands; current installs are already non-interactive except for any password prompt from `sudo` while installing missing system packages.

`--clean` removes the installed Dexyd app directory, user service, and `~/.local/bin/dexyd` command link, then exits.

Use a custom repository or branch while testing forks:

```bash
curl -fsSL https://raw.githubusercontent.com/DrB0rk/dexyd/main/scripts/install.sh | \
  DEXYD_REPO_URL=https://github.com/you/dexyd.git DEXYD_BRANCH=dev bash
```

From an existing checkout, run:

```bash
bash scripts/install.sh --use-current
```

`--use-current` uses the current checkout as the source, but still deploys Dexyd into the app install directory. It does not run the bridge from your development repository.

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

For an installed bridge, rerun the installer:

```bash
curl -fsSL https://raw.githubusercontent.com/DrB0rk/dexyd/main/scripts/install.sh | bash
```

From a local checkout, reinstall into the proper app directory:

```bash
bash scripts/install.sh --use-current
```

For a source checkout that you intentionally run in-place:

```bash
git pull
npm install
npm run build
```

Restart the bridge or user service after updating.

## Uninstall / reset

Remove an installed bridge:

```bash
curl -fsSL https://raw.githubusercontent.com/DrB0rk/dexyd/main/scripts/install.sh | bash -s -- --clean
```

Or, from a checkout:

```bash
bash scripts/install.sh --clean
```

To stop only the user service:

```bash
systemctl --user disable --now dexyd.service
```

Local Dexyd state is normally stored under `.dexyd/` in the repository or configured data directory. Removing that directory removes local bridge DB state, pairings, trusted devices, logs, and plugin data for that install.

The mobile app also has **Settings → Diagnostics → Reset app** to clear local mobile state.
