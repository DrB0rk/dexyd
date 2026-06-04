# Architecture

Dexyd is split into a local bridge, a mobile app, and an operator TUI.

```text
Phone app  <--HTTPS/HTTP + WebSocket-->  Dexyd bridge  <--exec/files-->  Codex/OMX + workspace
                                            |
                                            +-- SQLite state
                                            +-- TUI operator controls
                                            +-- optional Caddy/Cloudflare exposure
```

## Main components

### Bridge

The bridge is a TypeScript Fastify service. It owns:

- route registration;
- auth and pairing;
- event stream and replay;
- session aggregation;
- chat process management;
- project/file/diff services;
- Codex auth/usage status;
- SQLite persistence.

Important source areas:

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Bridge entry point. |
| `src/app.ts` | App construction. |
| `src/http/register-routes.ts` | REST/WebSocket routes. |
| `src/config/` | Config schema/loading and advertised URL logic. |
| `src/db/` | SQLite setup and migrations. |
| `src/domain/` | Zod schemas and domain types. |
| `src/services/` | Auth, pairing, session, chat, file, diff, project services. |
| `src/runtime/` | Runtime state, stream hub, diagnostics. |
| `src/modules/` | Module registry/lifecycle. |

### Mobile app

The mobile app is a React Native CLI app under `mobile/dexydMobile`. It owns:

- bridge profiles;
- pairing UI;
- sessions and project selector;
- focused chat;
- inbox interactions;
- settings;
- offline cache;
- realtime event handling.

The app talks only to the bridge API. It does not run Codex directly.

### TUI

The TUI is a Python Textual app at `tui/dexyd_tui.py`. It owns:

- config editing;
- pairing QR generation;
- Cloudflare named tunnel flow;
- bridge status checks;
- session/device visibility;
- Linux user-service install.

### SQLite

SQLite stores local bridge state:

- devices;
- refresh token hashes;
- pairing challenges;
- sessions;
- events;
- hidden sessions;
- settings/audit records.

The database is local to the bridge host.

## Request flow: pairing

1. User configures connection mode in TUI.
2. TUI calls pairing start or constructs a pairing QR from bridge data.
3. Mobile scans QR.
4. Mobile completes pairing with challenge and device label.
5. Bridge creates trusted device and returns access/refresh tokens.
6. App stores bridge profile and tokens.

## Request flow: chat turn

1. User opens a session and sends a message.
2. Mobile optimistically displays the user message.
3. Bridge receives `POST /sessions/:id/chat`.
4. Bridge emits `chat.message.user` and `chat.turn.started`.
5. Bridge launches Codex/OMX for the session workspace.
6. Output is parsed into compact status, assistant/system messages, and events.
7. Mobile updates chat through WebSocket and/or polling/replay.
8. On mobile-started turns, the bridge compares a bounded pre-turn snapshot with the completed workspace state and emits a per-turn diff event for the completed message.

## Event model

Each event has a monotonically increasing sequence. WebSocket clients receive live events. If a client disconnects, it can request replay after its last sequence.

If replay is too old, the bridge returns a snapshot so the app can refresh state.

## Session model

Dexyd lists both:

- sessions created in Dexyd's local DB;
- existing Codex/OMX sessions detected from the Codex session service.

Session deletion removes local Dexyd sessions. External sessions are hidden from Dexyd lists because Dexyd should not delete upstream Codex history it does not own.

## File and diff model

File and diff APIs operate relative to the session workspace and remain confined to `codex.workspaceRoot`. The bridge supports both current workspace/session diffs and per-turn diffs captured for mobile-started chat turns. Per-turn summaries power the mobile chat's **View message diff** action.

## Harness model

Dexyd supports three launch modes:

- `direct` — call `codex exec` through `codex.runtimePath`.
- `omx` — call `omx exec` so OMX features are available.
- `custom` — call a configured wrapper that behaves like a compatible exec harness.

## Error handling strategy

The bridge returns structured JSON errors like:

```json
{ "error": "session_not_found" }
```

The mobile app stores user-visible errors in error history and avoids repeated duplicate popups for the same connection failure.

## Design principles

- Keep bridge local-first and small.
- Authenticate everything except health/capability/pairing bootstrap.
- Confine filesystem access.
- Prefer simple mobile UX over exposing raw tool noise.
- Make connection mode explicit before pairing.
- Treat external Codex sessions as references, not Dexyd-owned records.
