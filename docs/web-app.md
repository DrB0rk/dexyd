# Self-hosted web control app

Dexyd includes a clean browser control app that can run in Docker while your normal Dexyd bridge and TUI keep running on the host system.

The Docker container does **not** run Codex, the bridge, or the TUI. It only:

- serves the browser UI;
- proxies REST/WebSocket traffic to the host bridge;
- uses the bridge's normal auth/session/diff/queue APIs.

## What you can do from the web UI

The web UI mirrors the core Android app workflows:

- choose or type any project path, with autocomplete and an up-directory button;
- create Codex sessions in the selected project;
- view project-scoped sessions with live status;
- read and send chat messages with local draft/message caching;
- insert dynamic `/` and `$` commands;
- see queued messages, steer or remove them;
- answer approvals and agent questions from Inbox;
- view per-turn code diffs and copy chat text;
- monitor bridge, realtime, account, and usage state;
- hide and restore Dexyd sessions.

## Requirements

Start or install the normal host bridge first:

```bash
dexyd --tui
```

or check the service:

```bash
systemctl --user status dexyd.service
```

The bridge must be reachable from Docker at `http://host.docker.internal:4242`. Dexyd installs the bridge listening on `0.0.0.0:4242` by default, so the web container can reach it through Docker's host-gateway alias.

## Docker Compose quick start

From the repository root:

```bash
docker compose up -d --build
```

Open:

```text
http://localhost:8080
```

Or from another device on your LAN:

```text
http://<computer-lan-ip>:8080
```

No Docker secrets are required. The browser asks the host bridge for a normal Dexyd web device token. Tokens are stored in the browser's `localStorage`.

## How it connects to the bridge

The Compose file publishes the web UI and points the container at the host bridge:

```yaml
ports:
  - "${DEXYD_WEB_PORT:-8080}:8080"
extra_hosts:
  - "host.docker.internal:host-gateway"
environment:
  BRIDGE_URL: http://host.docker.internal:4242
```

The web app uses same-origin URLs like `/sessions`, `/ws`, and `/web/auth/bootstrap`; Nginx proxies those requests to the host bridge. WebSocket traffic is proxied too.

## Configuration

Common overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEXYD_WEB_PORT` | `8080` | Published host port for the web UI. |
| `DEXYD_BRIDGE_URL` | `http://host.docker.internal:4242` | URL of the host Dexyd bridge from inside the container. |
| `WEB_PORT` | `8080` | Internal Nginx listen port; normally leave unchanged. |

If your host bridge runs on another port, set an environment variable in Portainer or your shell before deploying:

```bash
DEXYD_BRIDGE_URL=http://host.docker.internal:4243 docker compose up -d
```

To publish a different web port:

```bash
DEXYD_WEB_PORT=8090 docker compose up -d
```

## Updating

Pull, rebuild, restart:

```bash
git pull
docker compose up -d --build
```

The Docker container stores no Dexyd session data. Your sessions, tokens, and bridge database remain with the host bridge.

## Stop and remove

```bash
docker compose down
```

## Security notes

- Treat the web UI like the Android app: it can control Codex through the host bridge.
- Keep it on localhost/LAN unless you put HTTPS and authentication in front of it.
- Browser auto-login is accepted only for localhost/private-network hosts by default.
- The container does not mount your home directory, Codex credentials, GitHub credentials, or Dexyd data.
