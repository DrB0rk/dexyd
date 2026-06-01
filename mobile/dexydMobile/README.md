# dexydMobile (React Native CLI)

React Native CLI companion app for the dexyd bridge.

## Features implemented

- Drawer-style navigation with top-left hamburger menu
- Modern cockpit overview (bridge health, realtime stream state, auth, next steps)
- Guided pairing screen (QR camera scan or URI paste -> secure pairing)
- Chat-first workflow with session creation, streaming updates, and stop control
- Session management screen (create, refresh, state updates, clear empty states)
- Read-only Files and Diff screens for the active bridge workspace session
- Security screen (token refresh, revoke/sign-out, paired device review)

## Development

```bash
npm install
npm start -- --host 0.0.0.0
```

In another terminal from the repository root:

```bash
npm run mobile:android
```

## iOS bring-up

iOS requires macOS with Xcode:

```bash
bundle install
npm run ios:pods
npm run ios:sim
```

For a physical iPhone, choose a development team in Xcode and run
`npm run ios:device`.

## Bridge endpoint

The app does not use a loopback/default bridge endpoint. Configure it by either:

1. scanning a pairing QR from the bridge TUI, or
2. setting a LAN/domain URL in Settings, for example `http://10.0.0.88:4242` or `https://dexyd.example.com`.

The Android run scripts clear stale reverse tunnels and set React Native Metro to this computer's LAN IP. iOS uses the standard React Native CLI flow and pairs with the bridge through the QR/onboarding path.
