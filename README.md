# dexyd

Dexyd lets you control Codex and OMX sessions from your phone. It runs a small bridge on your computer, pairs with a trusted mobile app, and gives you a focused place to chat with sessions, answer approvals, respond to questions, review changes, and monitor usage.

## What you can do

- Pair your phone with one or more computers.
- See Codex/OMX sessions grouped by project.
- Open a session as a focused chat.
- Send messages and see responses in real time.
- Queue follow-up messages while a session is already working.
- Answer approval requests and multiple-choice questions from the app.
- Review per-message code diffs after assistant responses complete.
- Receive in-app notifications for replies, alerts, approvals, and questions.
- Check account and usage status.
- Configure LAN, domain, Caddy, or Cloudflare named-tunnel access through the bridge TUI.
- Revoke trusted devices when needed.

## Requirements

- A computer that can run the Dexyd bridge.
- Codex CLI installed and authenticated on that computer.
- Optional: OMX if you want Dexyd to launch sessions through OMX.
- A phone with the Dexyd mobile app installed.
- For remote access outside your LAN: a HTTPS domain, Caddy setup, or Cloudflare named tunnel.

## Install and start

On Linux, install Dexyd with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/DrB0rk/dexyd/main/scripts/install.sh | bash
```

The installer puts Dexyd in the XDG app data directory, normally `~/.local/share/dexyd`, cleans/replaces old Dexyd service and command links, checks bridge dependencies, creates configuration with your home directory as the workspace root, installs TUI dependencies, builds the bridge, links the `dexyd` command, verifies the install, and installs or restarts the user service. It does not build or install the Android app.

After installation, open the bridge TUI:

```bash
dexyd --tui
```

To remove an installed bridge before reinstalling:

```bash
curl -fsSL https://raw.githubusercontent.com/DrB0rk/dexyd/main/scripts/install.sh | bash -s -- --clean
```

The TUI is the main setup surface. Use it to start or inspect the bridge, configure connection settings, generate pairing QR codes, manage trusted devices, and set up Cloudflare named tunnels.

## Pair your phone

1. Start the bridge on your computer.
2. Open the Dexyd TUI.
3. Go to **Pair** and generate a QR code.
4. Open the mobile app.
5. Scan the QR code during onboarding or from **Settings → Pairing**.
6. The app saves that computer as a bridge profile.

You can pair multiple computers and switch between them from the app settings.

## Connection options

### LAN

Use LAN when your phone and computer are on the same network. This is the simplest option for home use.

### Domain or Caddy

Use a HTTPS domain when you want a stable remote address. Configure the public bridge URL in the TUI, then generate a fresh pairing QR code.

### Cloudflare named tunnel

Use the TUI Cloudflare flow when you want remote access without opening router ports. Dexyd can guide the named tunnel setup, save the tunnel URL, and regenerate pairing details.

## Using the app

### Sessions

The Sessions page shows Codex/OMX sessions by project. Each session shows whether it is idle, busy, waiting for input, waiting for approval, stopped, done, or errored.

Tap a session to open its chat. The chat opens as a full-screen page so the bottom navigation does not distract from the conversation.

### Inbox

Inbox is only for things that need attention, such as new messages, agent questions, approval requests, and important alerts.

### Chat

The chat view shows your messages, queued follow-ups, assistant responses, compact work status, and completed response actions. When a response changes files, use **View message diff** under that completed message to inspect the code changed by that turn.

### Settings

Settings contains connection profiles, pairing, account and usage status, security/trusted devices, workspace/project options, diagnostics, and app information.

## Security notes

- Pairing codes are temporary. Generate them only when you are ready to pair a trusted phone.
- Keep the bridge on a trusted LAN unless you are using HTTPS or a secure tunnel.
- Revoke old phones from the trusted device list if they are lost or replaced.
- Workspace access is confined to the configured workspace root.
- Prefer HTTPS domains or Cloudflare tunnels for remote access.

## Documentation

- [Documentation index](docs/index.md)
- [Installation](docs/installation.md)
- [Bridge and TUI](docs/bridge-tui.md)
- [Mobile app](docs/mobile-app.md)
- [Configuration](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security model](docs/security.md)

## License

No license has been declared yet.
