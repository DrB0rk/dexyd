# Mobile app

The Dexyd mobile app is the focused phone interface for Codex/OMX sessions. Android is the primary target today. iOS has an initial native target that shares the same JavaScript app.

## Core ideas

- **Bridge profile**: one paired computer/bridge, including URL and tokens.
- **Project**: a workspace directory under the bridge `codex.workspaceRoot`.
- **Session**: a Codex/OMX conversation for a project.
- **Inbox item**: something that needs attention, such as a question, approval, alert, or important update.
- **Chat page**: a full-screen conversation view opened from a session.

## First launch and onboarding

On first launch, the app guides you to pair with a bridge.

Typical flow:

1. Start the bridge on the computer.
2. Open the TUI.
3. Configure LAN/domain/tunnel.
4. Generate a QR code in the TUI Pair tab.
5. Scan the QR in the app.
6. The app stores the bridge profile and moves to the Sessions screen.

The QR carries the correct bridge URL, pairing ID, challenge, and expiration. Pairing automatically configures the app connection profile.

## Navigation

The app uses a compact bottom navigation for main areas except chat.

Main areas:

- **Inbox** — actionable items only.
- **Sessions** — projects and sessions, with status.
- **Settings** — connection, pairing, account/usage, security, diagnostics, and app info.

Chat is intentionally not in the bottom navigation. It opens only when you select or create a session, and it hides the bottom bar for focus.

## Project selector

The top selector shows known projects, not every folder inside a project. Use it to switch context before creating or selecting sessions.

New project flow:

- starts from the configured workspace root, usually the user's home directory;
- allows browsing directories;
- allows typing a custom path;
- offers autocomplete suggestions;
- remains confined to the bridge workspace root.

Removing a project from the app only removes it from Dexyd's selector/cache. It does not delete files from disk.

## Sessions screen

Sessions are grouped by project. Each session row shows status so multiple sessions can be monitored at once.

Common statuses:

| Status | Meaning |
| --- | --- |
| `busy` / `running` | The agent is currently working. |
| `waiting for input` | The agent needs a reply or answer. |
| `approval` | An approval request is pending. |
| `question` | A multiple-choice or text question is pending. |
| `error` | The last turn or connection hit an error. |
| `idle` | The session is available. |
| `done` / `completed` | The last run completed. |
| `stopped` / `cancelled` | The session was stopped. |

Swipe down to refresh Sessions. Cached sessions remain visible if the bridge is temporarily offline.

## Creating sessions

Use the plus action near the project selector or Sessions screen to create a new session for the selected project. Dexyd starts sessions in the selected workspace and launches Codex either directly or through the configured harness.

If the bridge is configured for OMX harness mode, mobile turns can use OMX behavior and commands through the bridge-side runtime.

## Chat

Chat opens as a dedicated full-screen page.

Chat includes:

- user messages;
- assistant messages;
- compact working status;
- queued follow-up messages;
- approval/question interactions;
- usage/account context in appropriate places;
- **View message diff** action after completed responses that changed files.

If a session is already busy, a newly sent message is queued instead of being dropped. The queue is visible from chat, and queued messages can be steered with extra guidance before they run.

The input box is docked above the keyboard and should remain visible across screen sizes.

## Working status

The app summarizes active work in a floating status area above the composer instead of dumping every tool call into the chat. It should show enough to understand what is happening without turning internal steps into noisy chat messages.

Examples:

- checking files;
- running tests;
- applying edits;
- waiting for approval;
- connection lost/retrying.

## Code diffs

When a completed assistant response changes code, a **View message diff** button appears under the relevant completed message. The diff is scoped to that turn/message, not the whole session.

The full-screen diff viewer shows:

- changed-file dropdown;
- per-file colored diff lines;
- summary stats;
- full raw diff text when needed;
- whether output was truncated;
- refresh and close actions.

Per-message diffs are captured around mobile-started turns. Older turns, external turns, or turns that did not change files may have no captured diff.

## Inbox

Inbox is not a general session list. It is only for items that need attention:

- new important messages;
- approval requests;
- agent questions;
- alerts;
- connection problems;
- account usage warnings when remaining usage crosses important thresholds.

Swipe down to refresh Inbox.

## Approvals and questions

Approvals and multiple-choice questions are rendered as integrated UI, not plain transcript text.

Approval actions include:

- approve;
- deny;
- optional note where supported.

Question actions include:

- selecting one of the provided choices;
- entering text for free-form questions where supported.

Responses are sent back to the bridge and emitted as interaction events.

## Settings

Settings uses simple submenus instead of one long scroll of options.

Major settings areas:

- **Connection** — bridge profiles, URLs, active bridge.
- **Pairing** — scan a new QR or update pairing.
- **Account & usage** — Codex account, usage/context status, auth switching where available.
- **Security** — trusted devices and sign-out/revoke actions.
- **Workspace** — project/workspace overview and selection.
- **Updates** — check GitHub Releases, download the latest APK, and open Android installer.
- **Diagnostics** — error history, app reset, connection checks.

App info is shown quietly at the bottom of Settings.


## App updates

Settings → Updates checks `https://github.com/DrB0rk/dexyd/releases/latest` and compares the latest release tag with the installed Android version. If an APK asset is attached to the release, the app can download it and open Android's package installer.

Android does not allow normal APK apps to silently update themselves. Dexyd can automate the check and download, but Android still asks you to confirm installation. On Android 8+, you may also need to allow Dexyd to install unknown apps before the installer opens.

The updater only trusts HTTPS GitHub release asset URLs. If a release has no APK attached, the app opens the GitHub release page instead.

## Multiple bridges

Each paired bridge profile stores its own:

- bridge URL;
- access/refresh tokens;
- cached sessions;
- cached project state.

Switch profiles in Settings → Connection. If a bridge URL changes, regenerate pairing from the TUI so the app stores the correct URL.

## Offline behavior

When the bridge is offline:

- cached sessions remain visible;
- connection state shows an error/offline indicator;
- sending messages is blocked or fails fast;
- reconnect/replay attempts resume when the bridge returns.

If replay has expired, the app refreshes full snapshots.

## Notifications

Dexyd currently has in-app notifications for:

- responses;
- alerts;
- approvals;
- questions;
- account usage warnings at important remaining-usage thresholds.

OS-level push/local notifications are planned but not complete.

## Diagnostics and reset

Settings → Diagnostics contains:

- error history;
- bridge/profile information;
- reset action.

Reset clears local app state and returns to onboarding. It does not delete bridge data from the computer.
