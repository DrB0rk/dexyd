# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-05-29
- Primary product surfaces:
  - React Native Android companion app in `mobile/dexydMobile/`
  - Textual bridge console in `tui/dexyd_tui.py`
- Evidence reviewed:
  - `README.md` — implemented bridge/mobile/pairing usage
  - `mobile/dexydMobile/README.md` — current Android app features and LAN-only flow
  - `docs/implementation-plan.md` — milestone roadmap and security/pairing goals
  - `mobile/dexydMobile/App.tsx` — current drawer screens and flows
  - `mobile/dexydMobile/src/ui/session-list.tsx` — current session list UI
  - `mobile/dexydMobile/src/ui/qr-scanner-modal.tsx` — current QR scanning modal
  - `tui/dexyd_tui.py` — current Textual TUI tabs and config/pairing/device flows

## Brand
- Personality: focused operator console, calm technical confidence, mobile-first control surface.
- Trust signals: explicit connection/auth state, clear token/device wording, safe destructive actions, readable timestamps, visible health checks.
- Avoid: toy-like neon overload, hidden security state, dense walls of IDs, ambiguous one-word buttons, flows that require knowing raw API details.

## Product goals
- Goals:
  - Make bridge status, pairing, sessions, and security understandable at a glance.
  - Make the first successful pairing obvious and low-friction.
  - Give local operators a fast TUI for setup, QR generation, and device review.
  - Preserve robust/authenticated behavior while improving affordances and feedback.
- Non-goals:
  - Full visual brand package or marketing website.
  - Complex native navigation dependencies before the app foundation stabilizes.
  - Pixel-perfect parity between mobile and TUI.
- Success signals:
  - A new user can identify whether bridge/mobile are connected in under five seconds.
  - Pairing can be completed by scanning a QR without reading API docs.
  - Empty/error/loading states explain the next action.

## Personas and jobs
- Primary personas:
  - Local developer running dexyd bridge and companion app over LAN or a configured domain.
  - Power user/operator managing sessions and paired devices.
- User jobs:
  - Start bridge/mobile, pair phone, verify connection, create/manage sessions, refresh/revoke credentials.
  - Generate pairing QR and adjust local bridge settings from a terminal.
- Key contexts of use:
  - Android phone connected to the same LAN, or configured through a public/domain bridge URL.
  - Terminal-driven development environment.
  - Dark-mode, developer workstation, local-only trust assumptions.

## Information architecture
- Primary navigation:
  - Mobile: hamburger drawer plus screen-specific top status; primary screens are Overview, Pairing, Sessions, Security.
  - TUI: task-oriented tabs for Dashboard, Pairing, Settings, Devices, Help.
- Core routes/screens:
  - Overview/Dashboard: status summary, next steps, quick actions.
  - Pairing: scan/generate QR, device label, completion state.
  - Sessions: create session, refresh, state transition actions, empty state.
  - Security/Devices: token expiry, refresh/revoke, paired device list.
- Content hierarchy:
  - Status and next action first.
  - Main action second.
  - Diagnostic details and raw IDs last.

## Design principles
- Principle 1: “Status before controls” — users should know what is connected, paired, or blocked before acting.
- Principle 2: “Guided local operator flow” — pairing/session/security tasks should include short instructions and clear next steps.
- Principle 3: “Readable technical detail” — IDs, paths, timestamps, and tokens are useful but visually secondary.
- Tradeoffs:
  - Use simple repo-native components over adding heavy navigation/UI libraries.
  - Favor stable dark UI and clear typography over complex animation.

## Visual language
- Color:
  - Dark graphite background, elevated panels, blue/cyan primary actions, green success, amber warning, red danger.
  - Color should always be paired with text labels.
- Typography:
  - Strong screen titles, small uppercase metadata labels, readable monospace-style IDs where possible through spacing and muted color.
- Spacing/layout rhythm:
  - 16px page padding, 12–16px card padding, consistent vertical rhythm, scrollable content.
- Shape/radius/elevation:
  - Rounded cards/buttons (12–20px mobile; rounded panels in TUI), light borders, no harsh shadows required.
- Motion:
  - Minimal; modal slide for scanner is enough. Avoid required animation.
- Imagery/iconography:
  - Use Unicode icons sparingly for nav/status (`☰`, `●`, `✓`, `⚠`) until an icon set is introduced.

## Components
- Existing components to reuse:
  - `SessionList`, `QrScannerModal`, hooks (`useAuth`, `useSessions`, `useBridgeStream`).
- New/changed components:
  - Mobile: shared theme tokens, cards, status pills, action buttons, empty states, screen headers, improved drawer.
  - TUI: clearer hero/status cards, task tabs, command help, framed QR output, device table-like list.
- Variants and states:
  - Buttons: primary, secondary, danger, disabled/loading.
  - Cards: default, highlighted/primary, warning/error.
  - Badges: connected, offline, paired, unpaired, warning.
- Token/component ownership:
  - Mobile theme tokens live in `mobile/dexydMobile/src/ui/theme.ts`.
  - TUI tokens remain in `DexydTextualApp.CSS` until a larger Python package split is warranted.

## Accessibility
- Target standard: practical WCAG AA contrast where feasible for text and controls.
- Keyboard/focus behavior:
  - TUI must support tab/focus and visible focus via Textual defaults.
  - Mobile controls need large touch targets and clear disabled states.
- Contrast/readability:
  - Avoid low-contrast gray-on-gray text; labels and error/success states must be legible.
- Screen-reader semantics:
  - Add descriptive button text; avoid icon-only controls without adjacent text.
- Reduced motion and sensory considerations:
  - No flashing, pulsing, or required animation.

## Responsive behavior
- Supported breakpoints/devices:
  - Mobile: Android phone portrait first, tolerant of landscape/tablet through flexible wrapping/scrolling.
  - TUI: terminal from ~90 columns upward; content remains scrollable at smaller heights.
- Layout adaptations:
  - Mobile drawer overlays/occupies a fixed width; screen content scrolls.
  - TUI uses tabs and scroll containers instead of wide-only layouts.
- Touch/hover differences:
  - Mobile uses large touch targets; TUI uses keyboard/mouse buttons.

## Interaction states
- Loading: show inline spinner/text near the affected action.
- Empty: explain what is missing and the next action (“Pair this phone”, “Create your first session”).
- Error: show concise error text and recovery step if known.
- Success: show paired/ready confirmations with green status badges.
- Disabled: dim buttons and prevent accidental duplicate submissions.
- Offline/slow network: show bridge health/down state and suggest checking bridge LAN reachability, firewall, and pairing URL.

## Content voice
- Tone: concise, operational, reassuring.
- Terminology:
  - Use “Bridge”, “Pairing”, “Session”, “Device”, “Token”, “LAN endpoint”.
  - Use “Revoke & sign out” for destructive auth removal.
- Microcopy rules:
  - Prefer action-oriented labels (“Scan QR”, “Create session”, “Refresh health”).
  - Avoid raw protocol details unless secondary/helper text.

## Implementation constraints
- Framework/styling system:
  - React Native Community CLI with StyleSheet; no new heavy UI or navigation dependency unless explicitly approved.
  - Textualize Python TUI launched by `npm run tui` through `bin/dexyd --tui`.
- Design-token constraints:
  - Keep RN tokens as plain TypeScript constants.
  - Keep TUI CSS readable and local to the TUI app.
- Performance constraints:
  - Keep lists virtualized where meaningful (`FlatList` for sessions).
  - Avoid polling loops unless user-triggered.
- Compatibility constraints:
  - Android USB development remains the primary target.
  - TUI should rely only on dependencies in `tui/requirements.txt`.
- Test/screenshot expectations:
  - Maintain mobile Jest smoke test, RN typecheck, lint, and bridge typecheck/tests.
  - Validate TUI syntax with Python compile; run Textual only interactively.

## Open questions
- [ ] Should dexyd adopt a formal icon set for mobile? / owner: product / impact: visual polish and bundle size
- [ ] Should mobile navigation move to React Navigation after more screens land? / owner: engineering / impact: native back behavior and deep linking
- [ ] Should TUI support direct local device revocation without an access token? / owner: security / impact: local admin power vs. consistency with API auth model
