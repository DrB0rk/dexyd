# dexyd — Complete Product Development Specification

Version: 1.0  
Project Name: dexyd  
Product Name: dexyd  
Target Platform: React Native Android + Self-Hosted Bridge  
Architecture Type: Modular Local Agent Bridge + Realtime Mobile Client  
Primary Goal: Secure, lightweight, expandable mobile access to a Codex runtime with full agent, harness, plugin, streaming, and operational control.

---

# 1. Executive Summary

dexyd is a self-hosted bridge and mobile companion system for remotely controlling a local Codex environment from an Android device.

dexyd consists of:

- `dexyd`: the local bridge daemon running on the machine that hosts Codex.
- dexyd mobile app: a React Native Android app.
- dexyd TUI: a lightweight terminal-based management interface served by the bridge.
- dexyd plugin SDK: a modular extension system for community-developed functionality.
- dexyd protocol: a simple HTTPS and WebSocket protocol for realtime control, streaming, synchronization, and notifications.

dexyd must feel like infrastructure software, not a consumer chatbot. It should be compact, understandable, modular, efficient, secure, and easy to deploy behind a reverse proxy.

The product should provide full Codex feature access while keeping the bridge thin, transparent, and capability-driven. dexyd should not attempt to reimplement Codex internals. Instead, it should expose Codex capabilities safely through a clean local bridge abstraction.

---

# 2. Product Philosophy

dexyd should follow five core principles.

## 2.1 Simple by Default

The default deployment should be understandable by a single developer.

A working setup should require:

- installing dexyd
- pointing dexyd at the Codex runtime
- opening the local TUI
- scanning a QR code
- connecting the Android app

Advanced features must not make the base product complicated.

## 2.2 Modular Internals

Every major capability should be isolated into a module:

- auth module
- session module
- stream module
- harness module
- notification module
- plugin module
- filesystem module
- terminal module
- Codex adapter module
- TUI module

Modules should communicate through clear internal interfaces.

## 2.3 Expandable Through Plugins

dexyd should include a first-class plugin system so the community can extend functionality without modifying core bridge code.

Plugins should support:

- custom harnesses
- custom tools
- custom notification providers
- custom UI panels
- custom automation triggers
- custom file actions
- custom session commands
- custom integrations

## 2.4 Secure by Design

dexyd controls a local AI coding agent. This is a high-trust, high-risk system.

Security must be built in from the start:

- TLS
- short-lived tokens
- device identity
- QR pairing
- revocation
- audit logs
- sandbox profiles
- plugin permissions
- least-privilege execution

## 2.5 Efficient and Lightweight

dexyd should be small and efficient.

It should avoid:

- Electron
- large UI frameworks
- unnecessary background work
- excessive polling
- large dependency trees
- heavyweight ORMs
- unbounded log buffers
- unbounded terminal history

---

# 3. Naming System

The project uses one name only: `dexyd`.

Use `dexyd` for the daemon, mobile app, TUI, protocol, plugin ecosystem, documentation, package namespace, and user-facing product identity. This keeps the product simple, searchable, and technically consistent.

Recommended technical naming:

```text
dexyd                 -> product and bridge daemon
dexyd mobile app      -> Android app
dexyd TUI         -> terminal-based local admin interface
dexyd protocol        -> REST/WebSocket protocol
dexyd plugin SDK      -> community plugin SDK
dexyd-plugin-*        -> plugin packages
dexydctl              -> optional CLI controller
```

Example service and CLI names:

```text
systemctl status dexyd
systemctl restart dexyd
dexydctl sessions
dexydctl plugins list
dexydctl devices list
```

---

# 4. Product Objectives

## 4.1 Primary Objectives

dexyd must provide:

- full Codex session access
- realtime streaming
- terminal/PTY access
- Codex tool and action visibility
- harness execution
- OMX-compatible harness support
- file browsing and diffs
- full code diff review
- patch approval/rejection
- apply/revert controls
- push notifications
- QR-based secure pairing
- reverse proxy support
- local TUI
- plugin support
- multi-device access
- multi-session access
- low resource usage

## 4.2 Non-Goals

dexyd should not become:

- a cloud SaaS dependency
- a generic web IDE
- an Electron desktop application
- a large multi-tenant platform
- a replacement for Codex
- a replacement for source control
- an unrestricted remote shell by default

---

# 5. High-Level Architecture

```text
┌────────────────────────────────────────────┐
│                dexyd mobile app                 │
│--------------------------------------------│
│ React Native Android                       │
│ Secure Storage                             │
│ WebSocket Client                           │
│ QR Pairing                                 │
│ Push Notifications                         │
│ Session UI                                 │
│ Terminal UI                                │
│ Plugin-Contributed Views                   │
└────────────────────────────────────────────┘
                     │
                 HTTPS/WSS
                     │
          Optional Reverse Proxy
                     │
┌────────────────────────────────────────────┐
│                  dexyd                     │
│--------------------------------------------│
│ REST API                                   │
│ WebSocket Gateway                          │
│ Auth Module                                │
│ Device Pairing Module                      │
│ Session Module                             │
│ Streaming Module                           │
│ Codex Adapter                              │
│ Harness Manager                            │
│ Plugin Host                                │
│ Notification Module                        │
│ File Module                                │
│ Terminal Module                            │
│ Audit Log Module                           │
│ Metrics Module                             │
│ dexyd TUI                                  │
└────────────────────────────────────────────┘
                     │
        Process / PTY / IPC / Filesystem
                     │
┌────────────────────────────────────────────┐
│              Local Runtime                 │
│--------------------------------------------│
│ Codex CLI / Codex Runtime                  │
│ OMX                                        │
│ Test Harnesses                             │
│ Plugin Harnesses                           │
│ Project Workspaces                         │
└────────────────────────────────────────────┘
```

---

# 6. Recommended Technology Stack

## 6.1 Mobile App

| Concern | Recommendation |
|---|---|
| Framework | React Native |
| Language | TypeScript |
| Runtime | Hermes |
| Navigation | React Navigation |
| State | Zustand |
| Network Cache | TanStack Query |
| Realtime | Native WebSocket |
| Secure Storage | Android Keystore through a React Native keychain library |
| Push Notifications | Firebase Cloud Messaging |
| QR Scanner | VisionCamera |
| Lists | FlashList or RecyclerListView |
| Markdown | Lightweight markdown renderer |
| Terminal | Native-backed terminal renderer or optimized xterm bridge |

Use bare React Native rather than an Expo-managed app if you need maximum control over size, native modules, secure storage, background behavior, and notification handling.

## 6.2 Bridge

| Concern | Recommendation |
|---|---|
| Runtime | Node.js 20+ |
| Language | TypeScript |
| API Framework | Fastify |
| WebSocket | uWebSockets.js or Fastify WebSocket |
| Database | SQLite |
| Logging | Pino |
| Process Management | systemd or PM2 |
| TUI | Terminal TUI |
| Plugin Runtime | Isolated subprocess or worker model |
| Queue | Lightweight in-process queue initially; Redis optional later |
| Metrics | OpenTelemetry-compatible metrics |

Node.js is a practical default because it aligns well with TypeScript sharing between bridge, TUI, mobile schemas, and plugin SDKs.

## 6.3 Infrastructure

| Concern | Recommendation |
|---|---|
| Reverse Proxy | Caddy by default |
| Alternative Proxy | Traefik or NGINX |
| TLS | Automatic HTTPS where possible |
| Packaging | Native service first, Docker optional |
| Storage | SQLite plus filesystem artifact storage |
| Deployment | Single-node by default |

---

# 7. Modularity Architecture

dexyd should be internally modular without becoming over-engineered.

## 7.1 Core Modules

### Auth Module

Responsible for:

- access tokens
- refresh tokens
- device identity
- revocation
- replay protection
- permissions

### Pairing Module

Responsible for:

- QR payload generation
- pairing session lifecycle
- device approval
- first trust establishment

### Session Module

Responsible for:

- Codex session lifecycle
- session metadata
- active session tracking
- session restoration
- session history

### Stream Module

Responsible for:

- websocket state
- event sequencing
- replay
- heartbeat
- backpressure
- stream aggregation

### Codex Adapter Module

Responsible for:

- Codex capability probing
- Codex execution
- Codex event parsing
- Codex error normalization

### Harness Module

Responsible for:

- OMX
- subprocess harnesses
- test harnesses
- plugin harnesses
- cancellation
- timeouts
- logs

### Terminal Module

Responsible for:

- PTY creation
- resize events
- input forwarding
- bounded history
- ANSI output processing

### File Module

Responsible for:

- workspace browsing
- file metadata
- file reads
- file writes
- file snapshots
- upload/download
- plugin file actions

### Diff Review Module

Responsible for:

- code diff generation
- patch parsing
- staged change inspection
- inline comments
- file-level approval
- hunk-level approval
- apply/reject/revert actions
- change risk classification
- review history
- mobile-safe patch control

### Notification Module

Responsible for:

- FCM dispatch
- local notification events
- notification routing
- offline wakeups

### Plugin Module

Responsible for:

- plugin discovery
- plugin loading
- plugin permissions
- plugin lifecycle
- plugin API surface
- plugin isolation

### TUI Module

Responsible for:

- terminal dashboard
- device management
- QR pairing
- plugin management
- logs
- metrics
- settings

---

# 8. Plugin System

The plugin system is a core product feature.

It should allow community developers to expand dexyd without modifying the bridge core.

## 8.1 Plugin Goals

Plugins should be able to add:

- new harnesses
- new command providers
- new notification sinks
- new session actions
- new file actions
- new dashboard panels
- new automation triggers
- new integrations
- new health checks
- new workspace analyzers
- new UI extensions

Examples:

- GitHub issue plugin
- GitLab merge request plugin
- Home Assistant notification plugin
- Discord notification plugin
- Matrix notification plugin
- Docker harness plugin
- Kubernetes harness plugin
- custom test runner plugin
- repository policy checker plugin
- CI status plugin
- mobile quick-action plugin

## 8.2 Plugin Design Principles

Plugins must be:

- sandboxed
- permission-scoped
- versioned
- auditable
- removable
- disabled by default after install until approved
- compatible with semantic versioning
- simple to develop

## 8.3 Plugin Types

| Plugin Type | Purpose |
|---|---|
| Harness Plugin | Adds a runnable execution backend |
| Tool Plugin | Adds actions exposed to Codex/dexyd |
| Notification Plugin | Adds external notification destinations |
| UI Plugin | Adds TUI/mobile panels or compact views |
| File Plugin | Adds file actions or previewers |
| Trigger Plugin | Adds automation/event triggers |
| Auth Plugin | Adds optional identity provider integrations |
| Workspace Plugin | Adds project-specific metadata and checks |

## 8.4 Plugin Manifest

Every plugin should include a manifest with:

```text
name
display_name
version
description
author
entrypoint
permissions
plugin_type
dexyd_api_version
minimum_dexyd_version
configuration_schema
ui_extensions
commands
```

## 8.5 Plugin Permissions

Plugins must request explicit permissions.

Recommended permission categories:

```text
workspace:read
workspace:write
session:read
session:control
terminal:spawn
harness:run
network:outbound
notifications:send
ui:panel
settings:read
settings:write
secrets:read
```

No plugin should receive broad access by default.

## 8.6 Plugin Isolation

Recommended isolation levels:

| Level | Use Case |
|---|---|
| In-process | Trusted first-party plugins only |
| Worker thread | Lightweight trusted plugins |
| Subprocess | Default for community plugins |
| Container | High-risk plugins or untrusted execution |

Community plugins should default to subprocess isolation.

## 8.7 Plugin Lifecycle

Plugin lifecycle states:

```text
installed
disabled
pending_approval
enabled
running
errored
quarantined
removed
```

## 8.8 Plugin Registry

Initial implementation can support:

- local plugin directories
- Git URL installation
- tarball installation

Future implementation can support:

- signed plugin registry
- verified publishers
- plugin ratings
- plugin compatibility metadata

## 8.9 Plugin TUI

The dexyd TUI should include:

- installed plugin list
- plugin permissions
- plugin settings
- plugin logs
- enable/disable controls
- update controls
- uninstall controls
- trust warnings

## 8.10 Plugin Security Rules

Mandatory plugin rules:

- no implicit network access
- no implicit filesystem write access
- no implicit terminal access
- all sensitive actions must be auditable
- plugins cannot access refresh tokens
- plugins cannot bypass sandbox profiles
- plugins cannot silently modify trusted device state
- plugins cannot install other plugins without explicit approval

---

# 9. Realtime Communication Architecture

## 9.1 Protocol Model

dexyd should use:

- REST over HTTPS for control-plane operations
- WebSocket over TLS for realtime state and streaming
- FCM for mobile notifications when the app is offline

## 9.2 REST Responsibilities

REST endpoints should handle:

- pairing
- login/token refresh
- device management
- settings
- plugin management
- session creation
- historical metadata
- health checks

## 9.3 WebSocket Responsibilities

WebSocket should handle:

- token streaming
- stdout/stderr streaming
- terminal input/output
- harness logs
- session state updates
- tool events
- plugin event
- diff ready for review
- patch applied
- revert completeds
- file change events
- notifications
- heartbeats

## 9.4 WebSocket Event Envelope

Every websocket event should include:

```text
sequence
timestamp
event_type
session_id
stream_id
source
payload
```

Example event categories:

```text
session.created
session.updated
session.completed
stream.token
stream.stdout
stream.stderr
tool.started
tool.completed
tool.failed
harness.started
harness.output
harness.completed
terminal.output
terminal.closed
file.changed
diff.created
diff.updated
diff.hunk.approved
diff.hunk.rejected
diff.applied
diff.reverted
review.comment.created
plugin.event
notification.created
auth.refresh_required
heartbeat
```

## 9.5 Event Replay

dexyd should support reconnect recovery.

The mobile app sends:

```text
last_seen_sequence
device_id
session_id
```

dexyd responds with:

- missed events if available
- state snapshot if replay window expired
- resync required if state is no longer recoverable

## 9.6 Heartbeat Strategy

Use adaptive heartbeat intervals:

| State | Interval |
|---|---|
| Active stream | 15–30 seconds |
| Idle foreground | 45–60 seconds |
| Background | minimized or suspended |
| Reconnect mode | exponential backoff |

---

# 10. Streaming Engine

## 10.1 Streaming Requirements

dexyd must stream:

- Codex tokens
- Codex tool calls
- stdout
- stderr
- harness logs
- terminal output
- plugin event
- diff ready for review
- patch applied
- revert completeds
- file change notifications

## 10.2 Stream Aggregation

Do not update the UI for every single byte or token.

Aggregate into short windows:

```text
20ms–60ms
```

This reduces:

- React Native rerenders
- websocket overhead
- garbage collection pressure
- battery usage

## 10.3 Stream Backpressure

The stream module must handle slow clients.

Required behavior:

- bounded outbound queues
- dropping non-critical telemetry first
- preserving critical session state
- detecting slow consumers
- disconnecting broken clients safely

## 10.4 Stream Persistence

Persist durable events:

- session lifecycle
- tool events
- harness start/stop
- errors
- approvals
- audit events

Do not persist every token forever by default.

---

# 11. Codex Integration

## 11.1 Codex Adapter Strategy

dexyd should treat Codex as the execution engine.

The adapter should:

- probe capabilities at startup
- expose normalized capabilities to clients
- stream machine-readable output where possible
- preserve Codex sandbox and permission semantics
- avoid hard-coded assumptions where possible

## 11.2 Capability Endpoint

dexyd should expose capabilities such as:

```text
codex_installed
codex_version
json_streaming_supported
mcp_supported
sandbox_profiles
approval_modes
image_inputs_supported
cloud_tasks_supported
harnesses_available
plugins_available
```

## 11.3 Session Profiles

dexyd should expose simple profiles instead of raw low-level flags.

Recommended profiles:

| Profile | Purpose |
|---|---|
| read_only | Analysis only |
| workspace_write | Safe workspace edits |
| harness_run | Test/harness execution |
| trusted_local | More permissive local control |
| plugin_defined | Plugin-defined custom mode |

Dangerous or unrestricted modes must never be default.

---

# 12. Harness System

## 12.1 Harness Goals

dexyd must support:

- OMX
- shell harnesses
- Docker harnesses
- test runners
- plugin-provided harnesses
- project-specific harnesses

## 12.2 OMX Support

OMX should be implemented as a first-party harness adapter.

dexyd should support:

- OMX availability checks
- OMX doctor checks
- OMX task execution
- OMX log streaming
- OMX failures
- OMX cancellation
- OMX configuration visibility

## 12.3 Harness Manager Responsibilities

The harness manager handles:

- process start
- process stop
- timeout
- cancellation
- resource tracking
- stdout/stderr capture
- log streaming
- failure classification
- plugin harness registration

## 12.4 Harness Profiles

Harness execution should be policy-driven.

Example policy fields:

```text
allowed_workspaces
allowed_commands
timeout_seconds
max_memory_mb
max_log_size_mb
allow_network
allow_write
requires_approval
```

## 12.5 Harness Isolation

Harnesses should run:

- outside the bridge process
- under restricted users when possible
- inside containers when needed
- with explicit workspace mounts
- with bounded runtime permissions

---

# 13. Terminal and PTY System

## 13.1 Terminal Features

dexyd should support:

- PTY sessions
- ANSI output
- terminal resizing
- stdin forwarding
- copy/paste
- scrollback
- reconnect recovery

## 13.2 PTY Security

Terminal access must be permission-gated.

Default behavior:

- disabled for untrusted devices
- approval required for new devices
- limited to configured workspaces
- logged in audit trail

## 13.3 PTY Optimization

Use:

- rolling scrollback buffers
- bounded output retention
- incremental ANSI processing
- chunked websocket transmission
- idle PTY suspension when possible

---

# 14. File System Features

## 14.1 File Browser

The app and TUI should support:

- workspace browsing
- file metadata
- file preview
- search
- diff view
- upload/download
- open modified files
- plugin file actions

## 14.2 File Security

dexyd should only expose configured workspace roots.

Do not expose:

- full home directories
- SSH keys
- global secrets
- arbitrary filesystem paths

## 14.3 File Optimization

Use:

- pagination
- lazy loading
- file size limits
- streaming downloads
- compressed transfer
- preview truncation for large files


---

# 15. Code Diff Review and Patch Control

## 15.1 Purpose

dexyd must provide first-class code diff review functionality in the mobile app and TUI.

The goal is to let the user safely inspect, approve, reject, apply, revert, and comment on changes generated by Codex, harnesses, plugins, or manual remote actions.

The app should provide full operational control without requiring the user to SSH into the host for routine review.

## 15.2 Core Diff Review Features

dexyd should support:

- workspace diff overview
- file-level diff view
- hunk-level diff view
- inline code comments
- syntax-highlighted diffs
- added/removed/modified/renamed/deleted file states
- binary file detection
- large file truncation
- whitespace-insensitive mode
- side-by-side diff mode where practical
- unified diff mode as default on mobile
- search within diffs
- changed file filtering
- risk indicators
- approval state per file
- approval state per hunk
- apply all approved changes
- reject selected hunks
- revert file
- revert entire session
- export patch
- copy patch
- open changed file
- view pre-change and post-change content

## 15.3 Mobile Diff Review Requirements

The Android app must provide a complete review workflow.

Required screens:

- Changed Files
- File Diff
- Hunk Review
- Inline Comment
- Patch Summary
- Apply/Revert Confirmation
- Review History

The user should be able to:

- inspect all pending changes
- approve or reject specific files
- approve or reject specific hunks
- add inline comments
- request Codex to revise a selected hunk
- apply approved changes
- revert unapproved changes
- stop a running session
- continue a session after review
- download or copy a patch

## 15.4 Full Control From the App

The app should expose full control over active Codex sessions and code changes.

Required controls:

| Control | Description |
|---|---|
| Stop Session | Immediately stop current Codex execution |
| Pause Session | Pause execution after current safe boundary |
| Continue Session | Resume paused session |
| Approve Action | Approve requested Codex action |
| Deny Action | Reject requested Codex action |
| Approve File | Mark entire file diff as approved |
| Reject File | Reject entire file diff |
| Approve Hunk | Approve one diff hunk |
| Reject Hunk | Reject one diff hunk |
| Apply Approved | Apply approved changes to workspace |
| Revert File | Restore file to previous snapshot |
| Revert Session | Revert all changes from a session |
| Request Revision | Ask Codex to revise selected code |
| Run Harness | Run selected test/harness after review |
| Run Plugin Action | Execute plugin-contributed review action |
| Commit Prep | Prepare commit metadata without committing by default |

## 15.5 Patch Safety Model

dexyd should never blindly apply large code changes from the mobile app without confirmation.

Required safety mechanisms:

- pre-change snapshots
- patch validation before apply
- path traversal prevention
- workspace root enforcement
- binary file protection
- max patch size limits
- max changed file count warning
- large deletion warning
- generated file warning
- lock file warning
- secret-looking content warning
- executable permission change warning
- dependency file change warning
- revert point creation before apply

## 15.6 Diff Data Model

Each diff should be represented as structured data.

Recommended entities:

```text
review_id
session_id
workspace_id
base_snapshot_id
current_snapshot_id
file_changes
hunks
comments
approval_state
risk_flags
created_at
updated_at
```

File change fields:

```text
path
old_path
change_type
language
additions
deletions
is_binary
is_large
risk_flags
approval_state
```

Hunk fields:

```text
hunk_id
file_path
old_start
old_lines
new_start
new_lines
content
approval_state
comments
```

## 15.7 Review States

Recommended review states:

```text
pending
partially_approved
approved
rejected
applied
reverted
superseded
conflicted
```

## 15.8 Risk Flags

dexyd should compute simple risk flags for review visibility.

Examples:

```text
large_deletion
dependency_change
lockfile_change
secret_pattern
binary_change
permission_change
generated_file
outside_workspace_attempt
test_file_only
config_change
migration_change
```

Risk flags should not block action automatically unless configured by policy.

They should make the review clearer.

## 15.9 Codex Revision Loop

The diff review UI should integrate directly with Codex.

From any file, hunk, or comment, the user should be able to request:

- explain this change
- revise this hunk
- simplify this implementation
- add tests
- fix failing harness
- reduce scope
- undo this change
- split this change into smaller steps

These requests should create structured follow-up instructions tied to the selected diff context.

## 15.10 Harness Integration

After reviewing changes, the user should be able to run harnesses directly from the app.

Common review actions:

- run tests for changed files
- run OMX harness
- run lint
- run typecheck
- run plugin-defined validation
- rerun failed harness
- compare before/after harness result

Harness results should attach to the review.

## 15.11 TUI Diff Review

The dexyd TUI should also support code review.

TUI features:

- changed file tree
- unified diff viewer
- file/hunk approval
- revert file
- revert session
- run harness
- show risk flags
- show comments
- approve/reject pending action
- export patch

Recommended shortcuts:

| Key | Action |
|---|---|
| a | Approve selected file/hunk |
| x | Reject selected file/hunk |
| r | Revert selected file |
| R | Revert entire session |
| h | Toggle hunk mode |
| c | Add comment |
| t | Run tests/harness |
| e | Explain selected change |
| q | Back |

## 15.12 Plugin Diff Review Extensions

Plugins should be able to contribute review functionality.

Plugin extension points:

- custom risk analyzers
- language-specific diff renderers
- test selectors
- code owners integration
- lint result overlays
- security scan overlays
- dependency impact analysis
- migration analyzers
- generated-code detectors
- custom apply policies

Plugin permissions required:

```text
diff:read
diff:comment
diff:approve
diff:apply
workspace:read
workspace:write
harness:run
```

Plugins should not be able to apply or revert patches unless explicitly granted `diff:apply`.

## 15.13 Diff Retention

dexyd should retain review metadata but avoid storing unlimited patch history.

Recommended defaults:

- keep active session diffs
- keep recent applied/reverted review metadata
- truncate very large patch bodies after configured retention
- store snapshots only when needed for revert
- allow manual cleanup from TUI

## 15.14 Mobile UX Rules for Diff Review

The mobile diff UI should be compact and practical.

Use:

- monospace code
- sticky file header
- compact hunk controls
- clear added/removed indicators
- small approval chips
- risk badges
- bottom action bar

Avoid:

- oversized cards
- animated diff effects
- excessive padding
- AI-style explanation panels by default
- hiding dangerous actions in menus

Critical actions such as apply, revert, and session stop must require clear confirmation.


---

# 16. QR Pairing System

## 15.1 Pairing Goals

QR pairing should provide:

- simple onboarding
- secure device trust establishment
- no manual token copying
- short-lived secrets
- user approval in TUI

## 15.2 QR Payload

The QR payload should include:

```text
bridge_url
pairing_session_id
one_time_secret
nonce
bridge_fingerprint
expires_at
protocol_version
```

## 15.3 Pairing Flow

1. User opens dexyd TUI.
2. TUI creates a temporary pairing session.
3. TUI renders QR code.
4. dexyd mobile app scans QR.
5. Mobile validates bridge URL and fingerprint.
6. Mobile generates device keypair.
7. Mobile submits public key and pairing claim.
8. TUI shows pending device approval.
9. User approves device.
10. dexyd issues refresh token and device identity.
11. Mobile stores credentials in Android Keystore.
12. WebSocket session opens.

## 15.4 Pairing Security Rules

- QR expires quickly.
- QR is one-time-use.
- Long-lived tokens are never stored in QR.
- Device approval must be explicit.
- Pairing attempts must be logged.
- Failed pairing attempts must be rate-limited.

---

# 17. Authentication and Authorization

## 16.1 Identity Model

dexyd supports device-based trust.

Each device has:

- device ID
- public key
- display name
- created timestamp
- last seen timestamp
- trusted/revoked state
- permissions
- notification token

## 16.2 Token Model

Use:

- short-lived access tokens
- rotated refresh tokens
- signed websocket tickets
- revocation lists

Recommended defaults:

| Token | Lifetime |
|---|---|
| Access token | 5–10 minutes |
| WebSocket ticket | 30–60 seconds |
| Refresh token idle timeout | 7 days |
| Refresh token absolute lifetime | 30 days |

## 16.3 Authorization Model

Permissions should be explicit.

Examples:

```text
session:create
session:read
session:control
terminal:open
filesystem:read
filesystem:write
diff:read
diff:comment
diff:approve
diff:apply
harness:run
plugin:manage
device:manage
settings:manage
```

## 16.4 Audit Logging

Audit logs should include:

- device pairing
- device approval
- token refresh
- failed login
- revoked device
- session creation
- terminal opened
- harness run
- plugin installed
- plugin enabled
- plugin permission changed

---

# 18. Reverse Proxy Support

## 17.1 Requirements

dexyd must support deployment behind:

- Caddy
- Traefik
- NGINX

Required proxy support:

- WebSocket upgrade
- HTTPS
- WSS
- forwarded headers
- request size limits
- rate limiting
- HSTS
- path-based routing if needed

## 17.2 Recommended Public Model

```text
Internet
   │
HTTPS/WSS
   │
Caddy / Traefik / NGINX
   │
127.0.0.1:dexyd
   │
Codex Runtime
```

## 17.3 Default Binding

dexyd should bind to loopback by default.

Recommended default:

```text
127.0.0.1:8787
```

Public binding should require explicit configuration.

---

# 19. dexyd TUI

## 18.1 TUI Purpose

dexyd should use a full terminal user interface for local setup, configuration, administration, pairing, monitoring, plugin management, and diagnostics.

The TUI replaces the browser-based GUI entirely.

The TUI should be:

- local-first
- keyboard-friendly
- simple to understand
- fast to launch
- low-memory
- suitable for SSH sessions
- usable on servers without a desktop environment
- clear for first-time setup
- powerful enough for day-to-day administration

The TUI should be launched with:

```text
dexyd
dexyd tui
dexyd setup
dexyd config
```

The daemon should also support non-interactive service mode:

```text
dexyd serve
```

## 18.2 Why TUI Instead of Web GUI

A TUI fits dexyd better than a browser interface because dexyd is infrastructure-oriented and usually runs on the same machine as Codex.

A TUI provides:

- smaller deployment size
- fewer dependencies
- lower memory usage
- no browser frontend build pipeline requirement
- no browser CORS surface
- no separate static asset serving
- easier SSH administration
- simpler local setup
- better alignment with daemon-style tooling
- less attack surface

The TUI should be treated as the primary administration surface.

The Android app remains the primary remote user interface.

## 18.3 Recommended TUI Stack

Recommended implementation options:

| Language | Recommended Library | Notes |
|---|---|---|
| TypeScript/Node.js | Ink | Best if dexyd remains TypeScript-first |
| TypeScript/Node.js | Blessed / Neo-blessed | More traditional terminal dashboard style |
| Go | Bubble Tea | Excellent for compact standalone binaries |
| Rust | Ratatui | Excellent performance and strong terminal UI model |

If dexyd is implemented in Node.js, use Ink for setup flows and a lightweight terminal dashboard, or Blessed/Neo-blessed if a more panel-based interface is required.

If dexyd later moves toward a single-binary architecture, Go with Bubble Tea is the strongest TUI direction.

## 18.4 TUI Modes

dexyd should support multiple TUI modes.

### First-Run Setup Mode

Triggered when no valid configuration exists.

Used for:

- Codex detection
- workspace selection
- reverse proxy mode
- bind address
- port selection
- TLS/proxy explanation
- QR pairing
- Android notification setup
- plugin directory setup
- service installation instructions

### Dashboard Mode

Used for regular administration.

Shows:

- dexyd status
- Codex status
- active sessions
- connected devices
- active harnesses
- plugin status
- CPU/RAM
- websocket clients
- recent errors
- notification status

### Configuration Mode

Used to edit configuration safely.

Supports:

- server bind address
- port
- trusted proxy settings
- workspace roots
- Codex path
- OMX path
- plugin directories
- notification provider settings
- retention policy
- log level
- metrics settings

### Pairing Mode

Used to connect the Android app.

Shows:

- terminal-rendered QR code
- pairing URL
- bridge fingerprint
- expiration countdown
- pending device requests
- approve/reject controls

### Plugin Mode

Used to manage community plugins.

Supports:

- list installed plugins
- install local plugin
- install from Git URL
- enable plugin
- disable plugin
- view plugin permissions
- approve requested permissions
- configure plugin
- view plugin logs
- quarantine plugin
- uninstall plugin

### Diagnostics Mode

Used for troubleshooting.

Runs checks for:

- Codex installed
- Codex authentication
- Codex JSON streaming support
- OMX installed
- OMX doctor
- workspace permissions
- port availability
- reverse proxy headers
- websocket upgrade support
- FCM configuration
- SQLite health
- plugin health
- filesystem permissions

### Logs Mode

Used to view:

- bridge logs
- auth logs
- session logs
- harness logs
- plugin logs
- audit logs
- notification logs

Logs must be searchable, filterable, and streamable.

## 18.5 TUI Navigation

The TUI should support keyboard-first navigation.

Recommended controls:

| Key | Action |
|---|---|
| Arrow keys / hjkl | Navigate |
| Enter | Select |
| Esc | Back |
| Tab | Next panel |
| Shift+Tab | Previous panel |
| / | Search |
| f | Filter |
| r | Refresh |
| p | Pair device |
| c | Configure |
| l | Logs |
| d | Dashboard |
| q | Quit |
| ? | Help |

The TUI should always show available shortcuts in a compact footer.

## 18.6 TUI Layout

Recommended dashboard layout:

```text
┌─ dexyd ─────────────────────────────────────────────────────────────┐
│ Status: running   Codex: ready   OMX: ready   Devices: 2   WS: 1   │
├─────────────────────────────┬──────────────────────────────────────┤
│ Active Sessions             │ Live Events                          │
│                             │                                      │
│  #184 running  workspace    │ 12:31 session.created                │
│  #183 waiting  approval     │ 12:31 stream.token                   │
│  #182 done     harness      │ 12:32 harness.output                 │
│                             │                                      │
├─────────────────────────────┼──────────────────────────────────────┤
│ Devices                     │ Harnesses / Plugins                  │
│                             │                                      │
│  Pixel 8    online          │ OMX              ready               │
│  Tablet     offline         │ docker-harness   enabled             │
└─────────────────────────────┴──────────────────────────────────────┘
[d] dashboard  [p] pair  [c] config  [l] logs  [?] help  [q] quit
```

Recommended setup layout:

```text
┌─ dexyd setup ───────────────────────────────────────────────────────┐
│ Step 2 of 7: Workspace Roots                                       │
├────────────────────────────────────────────────────────────────────┤
│ Select directories dexyd may expose to Codex and the mobile app.    │
│                                                                    │
│ Current roots:                                                     │
│  ✓ /srv/workspaces                                                 │
│  ✓ /home/user/projects/my-app                                      │
│                                                                    │
│ [Add root] [Remove selected] [Test permissions]                    │
└────────────────────────────────────────────────────────────────────┘
[enter] select  [a] add  [t] test  [n] next  [b] back  [q] quit
```

## 18.7 Setup Wizard

The setup wizard should be complete enough that a user can configure dexyd without manually editing files.

Required setup steps:

1. Welcome and explanation
2. Detect Codex
3. Detect OMX
4. Select workspace roots
5. Configure server bind address and port
6. Configure reverse proxy mode
7. Configure authentication and device pairing
8. Configure notifications
9. Configure plugin directories
10. Run diagnostics
11. Save configuration
12. Optionally install system service
13. Show QR code for first mobile pairing

## 18.8 Configuration Editing

The TUI should write to a normal human-readable config file.

Recommended path:

```text
/etc/dexyd/config.toml
```

User-level fallback:

```text
~/.config/dexyd/config.toml
```

The TUI must:

- validate before saving
- show changed values
- create backups before overwriting
- support reset to defaults
- support dry-run validation
- explain risky settings

## 18.9 TUI Pairing QR Code

The TUI must render QR codes directly in the terminal.

Pairing screen should show:

- QR code
- pairing URL fallback
- bridge fingerprint
- expiration timer
- pending device name
- requested permissions
- approve/reject buttons

Pairing must not require a web browser.

## 18.10 TUI Plugin Management

Plugin management should be fully available from the TUI.

Required features:

- install plugin from local path
- install plugin from Git URL
- list plugins
- inspect manifest
- inspect requested permissions
- enable/disable plugin
- configure plugin
- view plugin logs
- quarantine plugin after crash
- uninstall plugin

Community plugins should never become active until explicitly approved in the TUI.

## 18.11 TUI Security

The TUI is local administration software and should follow strict local security rules:

- do not expose the TUI remotely as a web server
- require local shell access
- protect config and state files with restrictive permissions
- clearly warn before enabling public bind
- clearly warn before enabling high-risk plugin permissions
- clearly warn before enabling permissive Codex profiles
- log all administrative changes

## 18.12 TUI Efficiency Requirements

The TUI should remain lightweight.

Targets:

| Metric | Target |
|---|---|
| TUI startup | <500ms preferred |
| Idle CPU | near-zero |
| Idle memory overhead | minimal |
| Redraw rate | only on state changes |
| Log rendering | virtualized / windowed |
| QR generation | on demand |

Avoid:

- constant redraw loops
- heavy animation
- full log loading
- large UI frameworks
- embedded browser engines

## 18.13 Non-Interactive Mode

All TUI operations should have non-interactive CLI equivalents for automation.

Examples:

```text
dexyd config validate
dexyd config set server.port 8787
dexyd pair create
dexyd devices list
dexyd devices revoke <device-id>
dexyd plugins list
dexyd plugins enable <plugin-name>
dexyd doctor
```

This keeps dexyd scriptable while still offering a full TUI for humans.


---

# 20. Mobile UI Design

## 19.1 Design Direction

dexyd mobile app should be:

- compact
- fast
- practical
- developer-focused
- information-dense
- restrained

It should not look AI-generated.

## 19.2 Avoid

- gradients
- giant cards
- excessive padding
- excessive border radius
- glassmorphism
- glowing effects
- oversized chat bubbles
- fake futuristic UI

## 19.3 Use

- 4px–8px radii
- 8px/12px/16px spacing
- 1px separators
- compact rows
- simple icons
- neutral colors
- monospace logs
- fast subtle transitions

## 19.4 Mobile Screens

Required screens:

- Pair Bridge
- Sessions
- Session Detail
- Terminal
- Files
- Harnesses
- Plugins
- Devices
- Settings
- Security

---

# 21. Mobile Feature List

## 20.1 Sessions

- create session
- resume session
- stop session
- archive session
- retry session
- view session state
- view streamed output
- approve requested action
- cancel running task

## 20.2 Terminal

- open PTY
- send input
- resize
- copy output
- reconnect
- close session

## 20.3 Files and Diff Review

- browse workspace
- preview file
- show diff
- review changed files
- approve/reject files
- approve/reject hunks
- add inline comments
- request Codex revisions
- apply approved patches
- revert files
- revert session changes
- download file
- upload file
- invoke plugin file actions
- invoke plugin review actions

## 20.4 Harnesses

- list harnesses
- run harness
- stop harness
- view logs
- view status
- inspect failures

## 20.5 Plugins

- view installed plugins
- view plugin permissions
- enable/disable plugin
- configure plugin
- use plugin-contributed actions
- view plugin logs

## 20.6 Notifications

- session complete
- session failed
- approval needed
- harness failed
- bridge offline
- security alert
- plugin event
- diff ready for review
- patch applied
- revert completed

---

# 22. Notification Architecture

## 21.1 Notification Channels

Recommended Android channels:

| Channel | Purpose |
|---|---|
| runs | Session completion and failures |
| approvals | Human approval required |
| security | Auth and device alerts |
| harnesses | Harness-specific events |
| plugins | Plugin-generated events |
| system | Bridge status |

## 21.2 Notification Rules

Notifications should:

- be concise
- avoid sensitive content
- avoid full logs
- avoid file contents
- open the relevant app screen
- fetch details after unlock

---

# 23. Persistence Layer

## 22.1 SQLite First

SQLite is the preferred initial database.

It is simple, local, fast, and easy to back up.

## 22.2 Stored Data

dexyd should store:

- devices
- sessions
- events
- plugin metadata
- settings
- pairing sessions
- audit logs
- refresh token hashes
- harness metadata
- diff review metadata
- patch approval state
- review comments

## 22.3 Filesystem Storage

Use filesystem storage for:

- artifacts
- large logs
- downloads
- plugin packages
- cached previews

Avoid storing large binary blobs in SQLite.

---

# 24. Performance and Efficiency

## 23.1 Core Targets

| Area | Target |
|---|---|
| Android APK | <25MB preferred |
| Mobile cold start | <1.5s |
| Mobile idle RAM | <150MB |
| Mobile active RAM | <300MB |
| Bridge idle RAM | <150MB |
| Bridge startup | <2s |
| Stream latency local | <100ms |
| Reconnect | <2s |
| Idle CPU | Near-zero |

## 23.2 Mobile Optimization

Use:

- Hermes
- bare React Native
- small dependency set
- virtualized lists
- lazy screens
- normalized state
- incremental rendering
- bounded caches

Avoid:

- heavyweight UI kits
- unnecessary animation libraries
- repeated markdown parsing
- large global stores
- unbounded logs

## 23.3 Bridge Optimization

Use:

- Fastify
- native streams
- SQLite WAL mode
- prepared statements
- bounded queues
- log rotation
- stream aggregation
- lazy plugin loading

Avoid:

- Prisma or heavy ORMs for hot paths
- loading large logs into memory
- per-session background polling
- always-on expensive metrics collection

## 23.4 Network Optimization

Use:

- one multiplexed websocket per device
- Brotli for HTTP
- websocket compression where beneficial
- event deltas
- state snapshots only when needed
- compact JSON initially
- optional MessagePack/CBOR later

## 23.5 Battery Optimization

Mobile app should:

- reduce heartbeat activity in background
- use push notifications for offline wakeup
- avoid constant timers
- batch UI updates
- suspend inactive streams
- reconnect with exponential backoff

---

# 25. Build and Packaging Optimization

## 24.1 Android

Enable:

- Hermes
- R8
- ProGuard
- resource shrinking
- ABI splits
- minified release builds

## 24.2 Bridge

Use:

- production dependency pruning
- small runtime image if containerized
- no dev dependencies in production package
- TUI bundle
- optional single-binary packaging later

## 24.3 Assets

Use:

- vector icons
- minimal font set
- optimized SVGs
- compressed static assets

Avoid:

- heavy PNG bundles
- large animated assets
- multiple font families

---

# 26. Plugin Development Model

## 25.1 Plugin SDK

dexyd should provide a small SDK with:

- manifest schema
- typed event API
- command registration API
- settings schema API
- permission request API
- logging API
- notification API
- harness registration API
- UI extension descriptors

## 25.2 Plugin API Surface

Plugins should be able to register:

```text
commands
harnesses
file_actions
diff_review_actions
session_actions
notification_handlers
dashboard_panels
mobile_panels
health_checks
automation_triggers
```

## 25.3 Plugin Events

Plugins may receive subscribed events:

```text
session.created
session.completed
session.failed
harness.started
harness.completed
file.changed
diff.created
diff.applied
diff.reverted
review.comment.created
device.connected
approval.requested
bridge.started
bridge.stopping
```

## 25.4 Plugin Configuration

Plugins should define a configuration schema.

dexyd TUI renders configuration forms automatically from the schema.

Configuration should support:

- strings
- booleans
- numbers
- enums
- secrets
- lists
- nested objects

Secrets must be stored separately and never exposed back to the plugin UI after saving.

## 25.5 Plugin Distribution

Initial:

- local directory
- Git repository
- archive upload

Future:

- signed registry
- verified publishers
- compatibility checks
- community rating
- automated security scan

## 25.6 Plugin Versioning

Use semantic versioning.

Plugin compatibility should include:

```text
minimum_dexyd_version
maximum_tested_dexyd_version
api_version
supported_platforms
```

## 25.7 Plugin Documentation Requirements

Each plugin should include:

- README
- manifest
- permission explanation
- configuration tuide
- examples
- changelog
- license

---

# 27. Security Model

## 26.1 Threat Assumptions

dexyd must assume:

- internet exposure is possible
- mobile devices can be stolen
- networks are hostile
- plugins may be malicious
- reverse proxies may be misconfigured
- Codex/harness outputs may contain secrets

## 26.2 Security Requirements

Mandatory:

- TLS in production
- no plaintext public access
- loopback bind by default
- short-lived access tokens
- rotating refresh tokens
- hashed refresh token storage
- device revocation
- plugin permission approval
- audit logging
- rate limiting
- workspace allowlists

## 26.3 Plugin Security

Plugins must not:

- access tokens
- bypass permissions
- silently access arbitrary filesystem paths
- run arbitrary terminal commands without permission
- enable themselves after being disabled
- install other plugins without approval
- modify device trust state
- bypass audit logs

## 26.4 Workspace Security

dexyd should expose only configured workspace roots.

Recommended workspace model:

```text
/srv/workspaces/project-a
/srv/workspaces/project-b
/home/user/dev/specific-project
```

Avoid allowing:

```text
/
~/
~/.ssh
~/.config
```

---

# 28. Observability

## 27.1 Logs

Use structured JSON logs.

Log categories:

- bridge
- auth
- websocket
- session
- harness
- plugin
- terminal
- notification
- audit

## 27.2 Metrics

Expose:

- active websocket clients
- active sessions
- active harnesses
- memory usage
- CPU usage
- plugin count
- failed auth count
- stream queue depth
- notification failures

## 27.3 Health Checks

Required endpoints:

```text
/healthz
/readyz
/capabilities
/metrics
```

---

# 29. Failure Handling

## 28.1 Expected Failures

dexyd must handle:

- Codex unavailable
- Codex auth expired
- OMX unavailable
- harness crash
- websocket disconnect
- reverse proxy timeout
- mobile app backgrounding
- plugin crash
- SQLite lock contention
- filesystem permission failure

## 28.2 Failure Strategy

Use:

- clear error codes
- human-readable messages
- retry where safe
- no silent failure
- audit critical failures
- isolate plugin crashes

---

# 30. Deployment Model

## 29.1 Default Local Deployment

Recommended default:

```text
dexyd runs on 127.0.0.1:8787
dexyd TUI available locally
Codex runtime available on same machine
Caddy exposes public HTTPS/WSS if configured
```

## 29.2 Service Deployment

Linux service:

```text
dexyd.service
```

Recommended directories:

```text
/etc/dexyd/config.toml
/var/lib/dexyd
/var/log/dexyd
/srv/workspaces
```

## 29.3 Docker Deployment

Docker is optional.

Docker should be used only when workspace mounts, Codex credentials, and harness requirements are clearly documented.

---

# 31. Configuration Model

## 30.1 Configuration File

Recommended config format:

```text
TOML or YAML
```

## 30.2 Configuration Areas

```text
server
auth
pairing
workspaces
codex
harnesses
plugins
notifications
logging
metrics
reverse_proxy
```

## 30.3 Configuration Principles

Config should be:

- readable
- minimal by default
- documented
- validated at startup
- visible in TUI where safe

---

# 32. Development Roadmap

## Phase 1 — Core dexyd Bridge

- Fastify server
- REST control API
- WebSocket gateway
- SQLite persistence
- Codex adapter
- basic TUI
- health checks

## Phase 2 — Mobile MVP

- QR pairing
- secure token storage
- session list
- realtime streaming
- basic notifications
- reconnect recovery

## Phase 3 — Harness Support

- OMX adapter
- harness manager
- subprocess isolation
- harness logs
- cancellation

## Phase 4 — Plugin System

- manifest schema
- plugin loader
- permissions
- plugin settings
- harness plugins
- notification plugins
- plugin TUI

## Phase 5 — Security Hardening

- audit logs
- revocation
- replay protection
- rate limiting
- workspace allowlists
- plugin sandboxing

## Phase 6 — Optimization

- APK size pass
- memory profiling
- websocket profiling
- stream batching
- SQLite tuning
- dependency trimming

## Phase 7 — Production Release

- documentation
- installers
- upgrade flow
- backups
- signed releases
- plugin registry foundation

---

# 33. Engineering Rules

## 32.1 Simplicity Rules

- Prefer one clear solution over many clever abstractions.
- Keep the bridge understandable.
- Avoid premature distributed systems.
- Avoid framework-heavy architecture.
- Prefer explicit interfaces.

## 32.2 Modularity Rules

- Each module owns one concern.
- Modules communicate through typed interfaces.
- Plugins use public APIs only.
- Core internals remain private.
- Community extensions must not require patching core code.

## 32.3 Efficiency Rules

- No unbounded buffers.
- No unnecessary polling.
- No large dependencies without justification.
- No full-state sync unless recovery requires it.
- No heavyweight TUI runtime.
- No Electron.

## 32.4 Security Rules

- No direct public Codex exposure.
- No plaintext remote access.
- No plugin implicit trust.
- No unrestricted shell by default.
- No long-lived access tokens.
- No secrets in notifications.

---

# 34. Final Product Characteristics

dexyd should feel:

- small
- fast
- clear
- modular
- extensible
- hackable
- secure
- operational
- developer-native

dexyd should not feel:

- bloated
- over-designed
- corporate
- flashy
- AI-generated
- opaque
- dependency-heavy

The final experience should be:

```text
Install dexyd.
Open the TUI.
Scan the QR code.
Control Codex from Android.
Add plugins when needed.
Keep everything secure, lightweight, and understandable.
```

dexyd is the daemon, mobile app, TUI, protocol, and plugin ecosystem.

Together they form a compact, secure, expandable mobile control plane for Codex.