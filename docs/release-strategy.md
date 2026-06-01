# Release strategy

Dexyd uses a staged release flow so bridge, TUI, and mobile app changes can stabilize before they reach normal users.

## Branches

### `dev`

Active development branch.

Use for:

- new features;
- UI iteration;
- bridge/API changes;
- mobile app experiments;
- documentation work.

Expected quality:

- typecheck passes;
- tests pass;
- local Android debug APK builds for mobile-impacting changes;
- docs updated for user-visible changes.

### `beta`

Stabilization branch.

Promote from `dev` after a coherent feature set is ready. Beta should be tested on at least one physical Android device and at least one real bridge profile.

Required beta checks:

- pairing over LAN;
- chat send/receive;
- sessions grouped by project;
- session delete/hide;
- approvals/questions;
- diff viewer;
- usage/account status;
- trusted-device revocation;
- offline cache behavior;
- one remote connection mode if changed.

### `main`

Stable branch.

Promote from `beta` only after release notes are written and known severe regressions are fixed.

## Versioning

Use semantic versioning.

| Type | Use for |
| --- | --- |
| Patch | Bug fixes, small UX polish, security hardening without behavior breakage. |
| Minor | Compatible features, new settings, new connection modes. |
| Major | Breaking config/API/session/mobile compatibility changes. |

Keep these aligned before tagging:

- root `package.json` version;
- mobile `package.json` version;
- Android version name/code when release builds are formalized;
- release notes.

## Release artifacts

Current artifact focus:

- Android release APK attached to published GitHub Releases.
- Source archive.
- Documentation.

The GitHub Actions APK workflow runs only when a GitHub Release is published. It does not build APKs for branch pushes, pull requests, or tag pushes by themselves.

Planned/future:

- signed Android release APK/AAB;
- iOS/TestFlight build;
- packaged bridge/TUI distributions.

## Release checklist

1. Merge feature work into `dev`.
2. Verify bridge typecheck/tests/build.
3. Verify mobile typecheck/lint/tests.
4. Build Android debug APK locally for smoke testing.
5. Smoke test on physical phone.
6. Update docs and screenshots if flows changed.
7. Promote `dev` to `beta`.
8. Test beta against LAN and selected remote mode.
9. Promote `beta` to `main`.
10. Create and publish GitHub Release `vX.Y.Z`.
11. Confirm the release workflow built and attached `dexyd-vX.Y.Z.apk`.

## Rollback strategy

If a release has a severe issue:

1. Mark the release as problematic in release notes.
2. Re-publish the previous known-good APK/artifact.
3. Patch `dev`.
4. Promote through `beta` again.
5. Release a patch version.

## Documentation requirements

Any user-visible feature should update at least one of:

- `README.md` for high-level user-facing changes;
- `docs/mobile-app.md` for app UX changes;
- `docs/bridge-tui.md` for TUI/bridge operations;
- `docs/configuration.md` for config changes;
- `docs/security.md` for trust/auth/exposure changes;
- `docs/troubleshooting.md` for common failure modes.
