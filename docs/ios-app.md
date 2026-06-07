# iOS app

Dexyd has a React Native CLI iOS target that shares the same JavaScript app as Android. The iOS project is ready for macOS/Xcode bring-up, including app identity, icons, pairing permissions, local network access, and OS notification support.

## Current scope

Implemented:

- iOS project under `mobile/dexydMobile/ios`.
- Swift `AppDelegate` React Native entry point.
- App display name: `dexyd`.
- Bundle identifier foundation: `app.dexyd.mobile`.
- Dexyd app icons in `Images.xcassets`.
- Camera permission text for QR pairing.
- Local network permission text for LAN bridge access.
- Narrow App Transport Security support for local HTTP bridge testing.
- Native iOS local notification module for prompt-finished and usage-limit notifications.
- npm scripts and setup helper.

Not complete yet:

- Apple signing/provisioning policy for public releases;
- TestFlight/App Store pipeline;
- iOS-specific visual QA on simulator and real devices;
- signed archive/release automation.

## Important platform limit

iOS development and builds require macOS with Xcode. Linux can install JavaScript/Ruby dependencies and edit Swift files, but it cannot install Xcode, run `xcodebuild`, install CocoaPods for an iOS target, launch the iOS Simulator, or sign an iPhone build.

Official setup references:

- React Native iOS setup requires Node, Xcode, and CocoaPods: <https://reactnative.dev/docs/set-up-your-environment>
- Apple Xcode is required for iOS SDK/build/signing: <https://developer.apple.com/xcode/>

## Requirements on macOS

- macOS.
- Xcode installed from the Mac App Store or Apple Developer Downloads.
- Xcode command line tools selected.
- Node.js 22 or newer for React Native tooling.
- Ruby Bundler.
- CocoaPods through the app Gemfile.

## One-command setup

From the repository root on macOS:

```bash
npm run mobile:ios:setup
```

The setup script installs JavaScript dependencies, installs Ruby/CocoaPods gems through Bundler, verifies Xcode, and runs CocoaPods.

On Linux it installs only portable dependencies and then stops with a clear message because the iOS SDK is unavailable.

## Manual pod install

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
- local networking App Transport Security exception for local HTTP bridge use;
- notification permission requested at runtime from Settings → Notifications.

Remote production use should prefer HTTPS domains or tunnels.

## Pairing on iOS

Use the same pairing flow as Android:

1. Configure LAN/domain/tunnel in the TUI.
2. Generate a fresh QR.
3. Scan it from the iOS app.
4. Allow local network access if iOS prompts.

## Updates on iOS

The Android APK updater does not apply to iOS. iOS updates must be installed by Xcode during development or distributed through TestFlight/App Store for normal users.

## Remaining iOS milestones

1. Run the app on simulator and physical iPhone.
2. Fix any iOS layout issues around safe areas and keyboard docking.
3. Validate QR scanning permission flow.
4. Validate local notifications while backgrounded and foregrounded.
5. Add signed release/archive instructions.
6. Add TestFlight pipeline if public iOS distribution is desired.
