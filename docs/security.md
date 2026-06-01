# Security model

Dexyd is designed for a trusted user controlling their own computer and phone. It can be used on a LAN or behind a public HTTPS/tunnel endpoint, but protected APIs are intended only for paired devices.

## Trust boundaries

| Boundary | Trust expectation |
| --- | --- |
| Bridge host | Trusted computer owned/administered by the user. |
| Mobile device | Trusted phone paired by scanning a short-lived QR. |
| LAN | Trusted enough for pairing and local use, but still authenticated. |
| Internet | Use HTTPS/tunnel and strong secrets; do not expose unauthenticated local services. |
| Workspace root | File/project access is confined here. Pick this carefully. |
| Codex/OMX process | Runs with the permissions of the bridge user account. |

## Authentication model

Pairing creates a trusted device and issues:

- short-lived access token;
- long-lived refresh token.

Access tokens authenticate normal API/WebSocket calls. Refresh tokens rotate through `/auth/refresh` and are stored hashed in SQLite.

Device revocation invalidates refresh tokens for that device.

## Pairing model

Pairing starts from the bridge side, usually the TUI. The QR contains:

- bridge URL;
- pairing ID;
- challenge;
- expiration.

Pairing start is restricted to local/private clients. Pairing completion requires the active challenge before creating device trust.

Security guidance:

- Generate QR codes only when pairing.
- Do not share screenshots of pairing QRs.
- Configure domain/tunnel first, then generate the QR.
- Revoke devices you no longer use.

## Token lifetimes

Defaults:

- access token: 900 seconds;
- refresh token: 30 days.

Shorter refresh tokens reduce exposure if a phone backup or token store is compromised. Longer refresh tokens reduce sign-in friction.

## Signing key

`auth.signingKey` signs access tokens and must be at least 16 characters.

For non-local setups:

- use a long random value;
- keep it out of git;
- rotate after suspected exposure;
- expect existing access tokens to become invalid after rotation.

## API access

Unauthenticated:

- health;
- capabilities;
- pairing start/complete.

Authenticated:

- devices;
- sessions;
- chat;
- events;
- projects;
- files;
- diffs;
- usage;
- Codex account state;
- interaction responses.

## WebSocket security

The WebSocket endpoint uses an access token query parameter:

```text
/ws?access_token=...
```

This is used because mobile WebSocket implementations do not always support custom headers. Avoid logging full request URLs at reverse proxies, or redact `access_token` query values.

## Workspace confinement

Dexyd confines project, file, and diff operations to `codex.workspaceRoot` using resolved real paths.

Set `workspaceRoot` narrowly if possible:

```yaml
codex:
  workspaceRoot: /home/you/Projects
```

Using `/home/you` is convenient but exposes more files to paired devices. Do not set the workspace root to `/`.

## Codex/OMX execution

Dexyd can launch Codex directly or through a harness like OMX. These processes run as the bridge user and can modify files in the selected workspace according to Codex behavior and user approvals.

Security guidance:

- run the bridge as your normal user, not root;
- choose a workspace root deliberately;
- inspect approvals before approving destructive actions;
- use trusted plugins/harnesses only.

## LAN exposure

LAN mode binds the bridge to `0.0.0.0` so your phone can connect. This is convenient but means any device on the LAN can reach the bridge port. Auth still protects APIs, but you should:

- use trusted networks;
- avoid public Wi-Fi for pairing;
- keep pairing windows short;
- close firewall access when not needed.

## Remote exposure

For remote access, prefer:

- Caddy with HTTPS;
- Cloudflare named tunnel;
- another reverse proxy with TLS.

Recommended remote shape:

```yaml
server:
  host: 127.0.0.1
  port: 4242
  publicBaseUrl: "https://dexyd.example.com"
```

Then let the proxy/tunnel forward to `127.0.0.1:4242`.

## Cloudflare named tunnels

Named tunnels avoid opening router ports. The TUI stores tunnel config/logs under `.dexyd/cloudflared/` and saves the public URL into Dexyd config.

Security guidance:

- use a hostname you control;
- keep Cloudflare account credentials safe;
- regenerate pairing after changing tunnel hostnames;
- revoke devices if a tunnel URL was shared unintentionally.

## Caddy/domain setup

A minimal Caddy shape:

```caddyfile
dexyd.example.com {
  reverse_proxy 127.0.0.1:4242
}
```

Avoid proxy logs that store full WebSocket query strings with access tokens.

## Audit logs

Dexyd writes audit records for security-relevant actions such as:

- pairing started;
- auth refresh/revoke;
- device revocation;
- session deletion;
- chat send;
- interaction responses;
- Codex account switch.

Audit records live in SQLite.

## Incident response

If a phone is lost:

1. Open the TUI or another trusted app profile.
2. Revoke the device.
3. Rotate `auth.signingKey` if token exposure is suspected.
4. Restart the bridge.

If the bridge config leaked:

1. Rotate `auth.signingKey`.
2. Revoke all untrusted devices.
3. Change tunnel/domain credentials if needed.
4. Review workspace root and logs.

If a public URL was exposed:

1. Remove/disable the route or tunnel.
2. Generate a new hostname if needed.
3. Re-pair trusted devices.
