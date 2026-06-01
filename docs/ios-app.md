# iOS app

Dexyd has an initial React Native CLI iOS target. It shares the same JavaScript app as Android, so the current iOS work is native setup, permissions, app identity, and basic run flow.

## Current scope

Implemented:

- iOS project under `mobile/dexydMobile/ios`.
- App display name: `dexyd`.
- Bundle identifier foundation: `app.dexyd.mobile`.
- Dexyd app icons in `Images.xcassets`.
- Camera permission text for QR pairing.
- Local network permission text for LAN bridge access.
- Narrow App Transport Security support for local HTTP bridge testing.
- npm scripts and environment check helper.

Not complete yet:

- signing/provisioning policy for releases;
- TestFlight/App Store pipeline;
- iOS OS-level notifications;
- iOS-specific visual QA on real devices;
- iOS release build documentation.

## Requirements

- macOS.
- Xcode.
- Xcode command line tools selected.
- Node.js 22 or newer for React Native tooling.
- Ruby Bundler.
- CocoaPods through the app Gemfile.

## Install pods

On macOS:

```bash
cd mobile/dexydMobile
bundle install
npm run ios:pods
```

## Run on simulator

Terminal 1:

```bash
cd mobile/dexydMobile
npm start
```

Terminal 2:

```bash
cd mobile/dexydMobile
npm run ios:sim
```

## Run on iPhone

1. Open `mobile/dexydMobile/ios/dexydMobile.xcodeproj` in Xcode.
2. Select the `dexydMobile` target.
3. Select a development team.
4. Connect the iPhone and trust the Mac.
5. Start Metro with `npm start`.
6. Run:

```bash
cd mobile/dexydMobile
npm run ios:device
```

## Permissions

Dexyd iOS declares:

- camera access for scanning pairing QR codes;
- local network access for LAN bridge communication;
- local networking App Transport Security exception for local HTTP bridge use.

Remote production use should prefer HTTPS domains or tunnels.

## Pairing on iOS

Use the same pairing flow as Android:

1. Configure LAN/domain/tunnel in the TUI.
2. Generate a fresh QR.
3. Scan it from the iOS app.
4. Allow local network access if iOS prompts.

## Remaining iOS milestones

1. Run the app on simulator and physical iPhone.
2. Fix any iOS layout issues around safe areas and keyboard docking.
3. Validate QR scanning permission flow.
4. Add local notifications for replies/approvals/questions.
5. Add signed release/archive instructions.
6. Add TestFlight pipeline if public iOS distribution is desired.
