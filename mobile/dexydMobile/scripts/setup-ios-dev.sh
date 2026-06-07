#!/usr/bin/env bash
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$MOBILE_DIR/../.." && pwd)"

log() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

log "Dexyd iOS development setup"
log "Project: $MOBILE_DIR"

if ! have node || ! have npm; then
  warn "Node.js and npm are required for React Native. Install Node.js 22+ first."
  exit 1
fi

if ! have ruby || ! have bundle; then
  warn "Ruby and Bundler are required for CocoaPods. Install Ruby/Bundler first."
  exit 1
fi

cd "$MOBILE_DIR"

log "Installing JavaScript dependencies"
npm install

log "Installing Ruby/CocoaPods dependencies"
bundle install

case "$(uname -s)" in
  Darwin)
    if ! have xcodebuild; then
      warn "xcodebuild was not found. Install Xcode from the App Store or Apple Developer Downloads."
      exit 1
    fi

    if ! xcode-select -p >/dev/null 2>&1; then
      warn "Xcode command line tools are not selected. Run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
      exit 1
    fi

    log "Installing iOS CocoaPods"
    npm run ios:pods

    log "iOS setup complete"
    log "Run simulator: cd mobile/dexydMobile && npm start    # terminal 1"
    log "               cd mobile/dexydMobile && npm run ios:sim # terminal 2"
    ;;
  *)
    warn "This host is not macOS. iOS builds require macOS with Xcode and an iOS SDK."
    warn "Portable dependencies were installed, but CocoaPods/Xcode build steps were skipped."
    warn "Copy this repo to a Mac or run this script on macOS to finish iOS setup."
    ;;
esac
