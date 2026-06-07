# Repository structure

Dexyd is organized around one local bridge, one terminal setup UI, and client control surfaces. Keep runtime data, generated builds, and machine-specific configuration out of git.

## Top-level layout

| Path | Purpose |
| --- | --- |
| `src/` | TypeScript bridge server, domain logic, services, modules, database migrations, and HTTP/WebSocket routes. |
| `tui/` | Textual-based terminal setup UI for bridge settings, pairing, tunnels, updates, and diagnostics. |
| `mobile/dexydMobile/` | React Native CLI mobile app shared by Android and iOS. |
| `mobile/dexydMobile/android/` | Android native project, APK updater, notification module, and release/debug builds. |
| `mobile/dexydMobile/ios/` | iOS native project, Swift app delegate, notification bridge, app icons, permissions, and Xcode project. |
| `mobile/dexydMobile/scripts/` | Mobile-target setup helpers, including iOS macOS/Xcode setup. |
| `scripts/` | User-facing installers and runtime helper scripts for the bridge/TUI. |
| `dev/` | Local development-only helpers and issue/task notes. Dev scripts are intentionally ignored unless explicitly promoted. |
| `test/` | Bridge/API/service regression tests. |
| `docs/` | End-user and maintainer documentation. |
| `assets/` | Shared project assets such as the Dexyd logo. |
| `bin/` | Command entrypoints for installed/source runs. |
| `.github/` | GitHub workflows and release automation. |

## Generated or local-only paths

These paths should not be committed:

- `.dexyd/` — local database, logs, TUI virtual environment, tunnel config/runtime data.
- `.omx/`, `.codex/`, `.claude/`, `.cursor/`, `.continue/`, `.windsurf/` — agent/editor/runtime state.
- `node_modules/`, `mobile/dexydMobile/node_modules/` — npm dependencies.
- `dist/`, Android/iOS build folders, Gradle caches, Metro caches.
- `dexyd.config.yaml`, `.env*`, keys, certs, keystores, and local credentials.
- `mobile/dexydMobile/vendor/bundle/` — Bundler-installed gems.

## Bridge organization

`src/` is split by responsibility:

- `config/` — config loading, schema validation, and bridge URL helpers.
- `core/` — module lifecycle primitives.
- `db/` — SQLite wrapper and migrations.
- `domain/` — shared domain types for auth, chat, sessions, projects, files, diffs, and events.
- `http/` — route registration.
- `modules/` — module registry and scaffolding helpers.
- `runtime/` — app context, stream hub, runtime state, and firewall diagnostics.
- `services/` — bridge services for auth, Codex sessions/chat, files, projects, pairing, events, diffs, and commands.

Prefer adding new bridge capabilities through a domain type, service method, route, and regression test rather than wiring logic directly into HTTP handlers.

## Mobile organization

`mobile/dexydMobile/` is a React Native CLI app:

- `App.tsx` contains the current UI shell and screen composition.
- `src/api/` contains the bridge client.
- `src/hooks/` contains stateful app hooks such as chat, usage, and updater behavior.
- `src/native/` contains typed wrappers for platform-native modules.
- `src/types/` contains shared mobile-side TypeScript types.
- `android/` and `ios/` contain native platform projects.

The Android and iOS apps share the same JavaScript UI. Native modules should expose the same JS-facing method names where practical, and unsupported platform behavior should fail closed with `available: false`.

## iOS-specific notes

The iOS target is intentionally kept inside the React Native app, not in a separate product folder. It needs macOS/Xcode for pods, build, signing, simulator, and device runs.

Setup helper:

```bash
npm run mobile:ios:setup
```

On Linux this installs portable dependencies and then stops before Xcode-only work.

## Installer organization

- Linux installer: `scripts/install.sh`
- Windows installer: `scripts/install-windows.ps1`
- Windows command shim: `scripts/install-windows.cmd`

Installers should be safe to run from a clean machine, preserve user config/runtime data where documented, and install into platform app-data locations rather than the development checkout.

## Documentation map

- `README.md` — concise end-user entry point.
- `docs/installation.md` — install/update/run instructions per platform.
- `docs/mobile-app.md` — mobile app UX and behavior.
- `docs/ios-app.md` — iOS target status and macOS setup.
- `docs/bridge-tui.md` — bridge/TUI operation.
- `docs/api-reference.md` — bridge API.
- `docs/security.md` — security model.
- `docs/troubleshooting.md` — known errors and fixes.
