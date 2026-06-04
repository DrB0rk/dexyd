# API reference

This is the bridge API used by the mobile app and TUI. It is not yet a stable public API contract, but documenting it makes integration and debugging easier.

## Base URL

The base URL is configured by pairing. Examples:

```text
http://10.0.0.88:4242
https://dexyd.example.com
```

## Authentication

Protected endpoints require:

```http
Authorization: Bearer <access-token>
```

Access tokens are obtained through pairing or refresh. Refresh tokens are only sent to `/auth/refresh` and `/auth/revoke`.

Unauthenticated endpoints:

- `GET /health/live`
- `GET /health/ready`
- `GET /capabilities`
- `POST /pairing/start` from local/private networks only
- `POST /pairing/complete`

## Health and capabilities

### `GET /health/live`

Basic liveness response.

Response:

```json
{ "status": "ok", "timestamp": "2026-06-01T00:00:00.000Z" }
```

### `GET /health/ready`

Readiness check for database and modules.

Response includes:

- `status`: `ready` or `degraded`;
- `database` health;
- module health map.

### `GET /capabilities`

Returns bridge name, modules, protocol support, and replay limits.

## Pairing and auth

### `POST /pairing/start`

Starts a short-lived pairing challenge. Restricted to local/private clients.

Body:

```json
{
  "bridgeBaseUrl": "https://dexyd.example.com",
  "expiresInSeconds": 300
}
```

Both fields are optional. `expiresInSeconds` must be between 30 and 900.

Response includes pairing ID, challenge, expiration, and pairing URI/payload fields used for QR generation.

### `POST /pairing/complete`

Completes pairing from either raw fields or a pairing URI.

Body with URI:

```json
{
  "pairingUri": "dexyd://pair?...",
  "deviceLabel": "Pixel 8"
}
```

Body with fields:

```json
{
  "pairingId": "uuid",
  "challenge": "challenge",
  "deviceLabel": "Pixel 8"
}
```

Response:

```json
{
  "deviceId": "uuid",
  "accessToken": "...",
  "refreshToken": "...",
  "accessExpiresAt": "...",
  "refreshExpiresAt": "..."
}
```

### `POST /auth/refresh`

Rotates refresh token and returns a new access/refresh pair.

Body:

```json
{ "refreshToken": "..." }
```

### `POST /auth/revoke`

Revokes the current device's refresh tokens. If a refresh token is supplied, it is revoked as well.

Body:

```json
{ "refreshToken": "..." }
```

## Devices

### `GET /devices`

Lists trusted devices.

### `DELETE /devices/:deviceId`

Revokes a trusted device and its refresh tokens.

## Codex account and usage

### `GET /codex-auth/status`

Returns detected `codex-auth` status, active account, account list, and install/availability hints where supported.

### `POST /codex-auth/switch`

Switches Codex account through `codex-auth`.

Body:

```json
{ "query": "account name or email" }
```

### `GET /usage/status?sessionId=<id>`

Returns session context status and account usage status from telemetry where available.

Context usage is session-specific when `sessionId` is supplied. Account usage is account-level and may be unavailable or summarized when the Codex runtime does not expose detailed limits.

## Projects

All project paths are confined to `codex.workspaceRoot`.

### `GET /projects?path=<path>`

Browse directories.

### `GET /projects/suggest?path=<partial>`

Returns autocomplete suggestions for project selection.

### `POST /projects`

Creates a new project directory.

Body:

```json
{
  "parentPath": "Projects",
  "name": "my-app"
}
```

## Sessions

Session IDs may be Dexyd UUIDs or Codex/OMX-style IDs containing letters, numbers, dots, underscores, colons, and dashes.

### `POST /sessions`

Creates a Dexyd session.

Body:

```json
{
  "workspacePath": "Projects/my-app",
  "profile": "default",
  "title": "Fix login"
}
```

### `GET /sessions?limit=100`

Lists sessions from local Dexyd DB plus detected Codex sessions, excluding hidden/deleted IDs.

### `GET /sessions/:sessionId`

Returns one session.

### `PATCH /sessions/:sessionId`

Updates status and/or profile for local sessions.

Body:

```json
{ "status": "idle", "profile": "default" }
```

Allowed statuses:

- `created`
- `running`
- `idle`
- `completed`
- `failed`
- `cancelled`

### `DELETE /sessions/:sessionId`

Deletes local sessions. For external Codex sessions that cannot be deleted from Dexyd's DB, the ID is hidden from future session lists.

Response:

```json
{ "deleted": false, "hidden": true }
```

### `POST /dexyd-chat/session`

Creates a Dexyd help session.

Body:

```json
{ "title": "dexyd help" }
```

## Chat

### `GET /sessions/:sessionId/chat?limit=200`

Returns chat messages.

Message roles:

- `user`
- `assistant`
- `system`
- `tool`

Message statuses:

- `sent`
- `running`
- `queued`
- `failed`
- `cancelled`

### `POST /sessions/:sessionId/chat`

Sends a user message and starts a Codex/OMX turn. If the session is already busy, the bridge queues the message instead of dropping it.

Body:

```json
{ "message": "Fix the failing test" }
```

Response status is `202 Accepted` and includes turn metadata:

```json
{
  "turnId": "uuid",
  "userEvent": { "sequence": 123, "eventType": "chat.message.user" },
  "queued": false
}
```

Queued response example:

```json
{
  "turnId": "uuid",
  "userEvent": { "sequence": 124, "eventType": "chat.message.queued" },
  "queued": true,
  "queueId": "uuid"
}
```

### `POST /sessions/:sessionId/cancel`

Cancels a running session turn where possible.

## Chat queue

### `GET /sessions/:sessionId/queue`

Returns queued messages for a busy session:

```json
{
  "queue": [
    {
      "queueId": "uuid",
      "turnId": "uuid",
      "sessionId": "session-id",
      "content": "Follow-up prompt",
      "createdAt": "2026-06-04T00:00:00.000Z",
      "updatedAt": "2026-06-04T00:00:00.000Z"
    }
  ]
}
```

### `POST /sessions/:sessionId/queue/:queueId/steer`

Adds steering guidance to a queued message before it runs.

Body:

```json
{ "message": "Also keep the change small and add a regression test." }
```

Response:

```json
{ "queued": { "queueId": "uuid", "content": "..." } }
```

### `DELETE /sessions/:sessionId/queue/:queueId`

Removes a queued message.

Response:

```json
{ "removed": true }
```

## Files and diffs

### `GET /sessions/:sessionId/files?path=<path>`

Lists a workspace directory.

### `GET /sessions/:sessionId/files/read?path=<path>&maxBytes=65536`

Reads a workspace file up to `maxBytes`, capped by the bridge.

### `GET /sessions/:sessionId/diff`

Returns current session/workspace diff summary:

```json
{
  "status": "ok",
  "stat": "1 file changed, 3 insertions(+)",
  "diff": "diff --git ...",
  "truncated": false
}
```

### `GET /sessions/:sessionId/diff?turnId=<turnId>`

Returns a per-turn diff summary captured for a completed mobile-started assistant turn:

```json
{
  "status": "ok",
  "stat": "2 files changed, 12 insertions(+), 3 deletions(-)",
  "diff": "diff --git ...",
  "truncated": false
}
```

If the turn has no captured diff, the bridge returns an empty diff summary. This can happen for older turns, external turns, failed turns, or turns that did not change files.

## Interactions

### `POST /interactions/:interactionId/respond`

Responds to approvals or questions.

Approval:

```json
{
  "kind": "approval",
  "sessionId": "uuid-if-known",
  "decision": "approved",
  "note": "Looks good"
}
```

Question:

```json
{
  "kind": "question",
  "sessionId": "uuid-if-known",
  "answer": "Use option A",
  "choiceId": "a"
}
```

## Events and realtime

### `GET /events/replay?lastSeenSequence=123&sessionId=<id>`

Replays events after a sequence number. If replay expired, response includes a snapshot.

### `GET /ws?access_token=<token>`

WebSocket endpoint. Token is supplied as query parameter because React Native WebSocket APIs do not consistently support custom headers.

The client receives event envelopes and replay responses. It may send a replay request message:

```json
{
  "type": "replay.request",
  "lastSeenSequence": 123,
  "sessionId": "optional-session-id"
}
```

Important event types include:

- `session.created`
- `session.updated`
- `session.deleted`
- `chat.message.user`
- `chat.message.queued`
- `chat.message.queued.updated`
- `chat.message.queued.removed`
- `chat.turn.started`
- `chat.output.delta`
- `chat.message.assistant`
- `chat.turn.diff`
- `chat.turn.cancelled`
- `chat.turn.failed`
- `interaction.approval.responded`
- `interaction.question.answered`
