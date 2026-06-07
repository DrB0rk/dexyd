# Self-hosted web control app

Dexyd includes a small browser control app that can run in Docker while your normal Dexyd bridge and TUI keep running on the host system.

The Docker container does **not** run Codex, the bridge, or the TUI. It only:

- serves the browser UI;
- proxies REST/WebSocket traffic to the host bridge;
- uses the bridge's normal auth/session/diff/queue APIs.

## Requirements

Start or install the normal host bridge first:

```bash
dexyd --tui
```

or check the service:

```bash
systemctl --user status dexyd.service
```

The bridge must be reachable on the host at `http://127.0.0.1:4242`. The Compose file uses Linux host networking so the web container can reach that normal local bridge address directly.

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

The Compose file uses host networking and points the web container at the normal local host bridge:

```yaml
network_mode: host
environment:
  BRIDGE_URL: http://127.0.0.1:4242
```

The web app uses same-origin URLs like `/sessions`, `/ws`, and `/web/auth/bootstrap`; Nginx proxies those requests to the host bridge. WebSocket traffic is proxied too.

## Configuration

Common overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEB_PORT` | `8080` | Port inside the web container. |
| `BRIDGE_URL` | `http://127.0.0.1:4242` | URL of the host Dexyd bridge from inside Docker host-network mode. |

If your host bridge runs on another port, edit `docker-compose.yml`:

```yaml
environment:
  BRIDGE_URL: http://127.0.0.1:4243
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
