# Implementation plan

Dexyd has moved beyond the original foundation milestone. This document captures the current product state, quality priorities, and next implementation milestones.

## Product goal

Dexyd should be a small, robust, security-minded mobile control surface for local Codex/OMX work. It should make phone-based session monitoring and interaction feel native without exposing unnecessary internal tool noise.

## Completed foundation

### Bridge

- Modular Fastify bridge.
- SQLite persistence and migrations.
- Health/readiness/capabilities endpoints.
- Authenticated REST APIs.
- Authenticated WebSocket stream.
- Event replay and snapshot fallback.
- QR pairing and trusted devices.
- Access/refresh token flow.
- Device revocation and audit logs.
- Session creation/list/delete/hide.
- External Codex/OMX session discovery.
- Chat send/cancel, queueing, steering, and output processing.
- Approval/question response endpoint.
- Usage/context status parsing.
- Codex account status/switch wrapper.
- Workspace-confined project/file/diff services, including bounded per-turn diff snapshots.

### Mobile app

- Onboarding and QR pairing.
- Multiple bridge profiles.
- Project selector and project creation flow.
- Sessions grouped by project.
- Session status indicators for multiple running sessions.
- Focused full-screen chat.
- Keyboard-aware composer.
- Compact working status instead of raw tool spam.
- User/assistant/system message handling.
- Markdown-ish message styling for common code/title patterns.
- Per-message View message diff action after completed assistant turns.
- Inbox for actionable updates, approvals, and questions.
- Integrated approval/question responses.
- Settings submenus.
- Account/usage visibility.
- Error history and reset.
- Offline session cache.

### TUI

- Textual UI.
- Status/dashboard.
- Pairing QR generation.
- Settings editing.
- LAN/domain URL handling.
- Cloudflare named tunnel flow.
- Trusted-device view.
- Session visibility.
- Linux user service install.

### Tooling/docs

- Linux installer with XDG app-directory deployment, service setup, verification, and clean removal.
- Android all-in-one build/run script.
- Manual Android APK build/upload process for releases.
- Initial iOS native target.
- End-user README.
- Expanded docs set.

## Quality priorities

1. **Robustness** — no silent failures for pairing, auth, session deletion, or chat send.
2. **Security** — authenticate protected APIs, confine filesystem access, avoid leaking tokens in logs.
3. **Simplicity** — keep mobile UI compact and task-focused.
4. **Modularity** — bridge services should remain small and testable.
5. **Recoverability** — offline cache, replay, clear diagnostics, and safe reset paths.
6. **Consistency** — shared language across app, TUI, README, and docs.

## Current architecture risks

| Risk | Mitigation |
| --- | --- |
| WebSocket token in query string can appear in proxy logs. | Document proxy log redaction and prefer trusted reverse proxies. |
| External Codex sessions cannot be truly deleted by Dexyd. | Hide external sessions and document behavior. |
| Mobile app has large single-file UI surface. | Continue extracting hooks/components as behavior stabilizes. |
| iOS is not fully verified. | Treat as early target until run on macOS/iPhone. |
| OS-level notifications are incomplete. | Keep in-app notifications reliable first. |

## Near-term milestones

### Milestone 1: Hardening and regression coverage

- More tests for session hide/delete across Codex-style IDs.
- Tests for optimistic chat messages and replay dedupe.
- Tests for interaction response payloads.
- Tests for usage status parsing edge cases.
- Security review of token logging and reverse proxy docs.

### Milestone 2: Mobile component extraction

- Extract session rows/status pills.
- Extract chat message rendering.
- Extract interaction cards.
- Extract settings submenu components.
- Keep visual behavior unchanged while reducing file size.

### Milestone 3: Notifications

- Android local notifications for replies, approvals, and questions.
- Notification permission flow.
- Per-bridge/per-project notification settings.
- Quiet hours or low-noise mode.

### Milestone 4: Release packaging

- Signed Android release build.
- Reproducible release checklist.
- Release notes template.
- Optional APK update/install guidance in TUI.

### Milestone 5: iOS validation

- Run on simulator.
- Run on physical iPhone.
- Fix safe-area/keyboard issues.
- Validate QR scanning.
- Add iOS notification path.

### Milestone 6: Remote access polish

- Caddy guide with token-safe logging notes.
- Cloudflare tunnel status health checks.
- Better mobile display of active connection mode.
- Guided repair when bridge URL changes.

## Non-goals for now

- Multi-user hosted service.
- Running Codex on the phone.
- Broad plugin marketplace inside the mobile app.
- Arbitrary filesystem access outside workspace root.
- Public unauthenticated APIs.

## Definition of done for future features

A feature is done when:

- bridge behavior is implemented and authenticated where needed;
- mobile/TUI surface is simple and consistent;
- errors are visible and actionable;
- tests cover critical behavior;
- docs are updated;
- Android build still passes for mobile changes;
- security implications are reviewed.
