# Dexyd documentation

This folder contains the detailed Dexyd documentation. The root `README.md` is intentionally short and user-facing; this folder is where setup, operations, security, implementation, and reference details live.

## Start here

- [Installation](installation.md) — install, start, update, and platform setup.
- [Bridge and TUI](bridge-tui.md) — how the local bridge and terminal UI are used.
- [Mobile app](mobile-app.md) — app navigation, pairing, sessions, chat, inbox, and settings.
- [Troubleshooting](troubleshooting.md) — common connection, pairing, session, and build problems.
- [Repository structure](repository-structure.md) — where bridge, TUI, mobile, installers, docs, and generated files live.

## Reference

- [Configuration](configuration.md) — full `dexyd.config.*` reference.
- [API reference](api-reference.md) — REST/WebSocket endpoints used by the mobile app.
- [Security model](security.md) — trust boundaries, tokens, workspace confinement, and public exposure.
- [Architecture](architecture.md) — how the bridge, mobile app, TUI, storage, and Codex/OMX integration fit together.

## Platform and release notes

- [iOS app](ios-app.md) — current iOS bring-up state and next steps.
- [Release strategy](release-strategy.md) — branch, versioning, and release checklist.
- [Implementation plan](implementation-plan.md) — completed milestones, current quality goals, and roadmap.

## Documentation conventions

- Commands assume the repository root unless a section says otherwise.
- `dexyd --tui` means the installer linked the `dexyd` command into your shell path.
- `npm run tui` is the fallback when running directly from the source checkout.
- Public remote use should mean HTTPS through Caddy, Cloudflare named tunnel, or another trusted reverse proxy.
