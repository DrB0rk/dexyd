# Troubleshooting

Use this guide when pairing, connection, sessions, chat, or mobile behavior does not work as expected.

## Quick checks

From the bridge computer:

```bash
curl http://127.0.0.1:4242/health/live
curl http://127.0.0.1:4242/health/ready
```

From another device on the LAN, replace the IP with the bridge computer's LAN IP:

```bash
curl http://10.0.0.88:4242/health/live
```

If local works but LAN does not, check bind address and firewall.

## Installer uses the wrong location

The installed bridge should run from the XDG app directory, normally:

```text
~/.local/share/dexyd
```

Check the command link:

```bash
readlink -f ~/.local/bin/dexyd
```

If it points into an old development checkout or `dexyd` looks for `~/.local/package.json`, clean and reinstall:

```bash
bash scripts/install.sh --clean
bash scripts/install.sh --use-current
```

The first command removes the old app directory, user service, and command link. The second copies the current checkout into the app directory and installs from there.

## Phone cannot connect on LAN

Check:

1. Phone and computer are on the same network.
2. Bridge is bound to `0.0.0.0`, not only `127.0.0.1`.
3. Firewall allows TCP `4242`.
4. Pairing QR used the LAN IP, not localhost.
5. VPN/private DNS is not blocking local routes.

If needed, allow TCP `4242` in your OS firewall. With `ufw`, for example:

```bash
sudo ufw allow 4242/tcp comment dexyd
```

## Pairing QR points to the wrong URL

Pairing payloads include the bridge URL at generation time. Fix:

1. Open TUI Connect/Settings.
2. Configure LAN/domain/tunnel URL.
3. Save settings.
4. Generate a new QR.
5. Pair again in the app.

Do not reuse old QR screenshots after changing connection mode.

## Cloudflare tunnel connects but pairing still uses LAN

`server.publicBaseUrl` must be set to the tunnel HTTPS URL before pairing. Use the TUI named-tunnel flow and generate a fresh QR after the tunnel is started.

If Cloudflare reports that the requested tunnel name or hostname is already taken, the TUI asks whether to overwrite it. Choose **Overwrite** only when that tunnel/hostname should belong to this Dexyd install, or cancel and enter a different value in Advanced. Dexyd saves the selected tunnel name in `cloudflare.tunnelName`, the hostname in `cloudflare.hostname`, and the pairing URL in `server.publicBaseUrl`. Check `.dexyd/cloudflared/tunnel.json` and `.dexyd/cloudflared/config.yml` to confirm the active tunnel and hostname.

## App shows realtime closed / WebSocket 1006

Possible causes:

- bridge unreachable from phone;
- wrong bridge URL in profile;
- reverse proxy not forwarding WebSocket upgrades;
- token expired and refresh failed;
- firewall or tunnel idle timeout.

Checks:

1. Open health URL from the phone browser.
2. Re-pair if the bridge URL changed.
3. For Caddy, confirm WebSocket upgrade forwarding is not disabled.
4. Check bridge logs for `unauthorized` or connection errors.

## App says connected after refresh but actions fail

The health endpoint may be reachable while authenticated APIs fail. Try:

1. Settings → Connection → reselect bridge profile.
2. Settings → Pairing → scan a new QR.
3. Settings → Security → verify device still trusted.
4. Revoke old device and pair again.

## Cannot delete sessions

Dexyd handles two session types:

- local Dexyd sessions can be deleted;
- external Codex/OMX sessions are hidden from Dexyd lists, not deleted from upstream history.

If delete shows a top-left error:

1. Refresh sessions.
2. Confirm bridge is up.
3. Check mobile Settings → Diagnostics → Error history.
4. Re-pair if authenticated requests are failing.
5. Check bridge logs for `invalid_session_id`, `unauthorized`, or `session_not_found`.

## Sent message is missing from chat

The app should optimistically show your message immediately. If it does not:

1. Confirm the active session is not stale or deleted.
2. Refresh the chat.
3. Check realtime connection status.
4. Check error history for failed `POST /chat` requests.
5. Reopen the session from the Sessions page.

## Chat status is cut off or keyboard hides input

The app is designed to dock the composer above the keyboard and float working status above the composer. If layout is wrong:

1. Update to the latest app build.
2. Restart the app.
3. Check Android display scaling/font scaling.
4. Report device model, Android version, and a screenshot.

## Messages appear twice

This usually means both optimistic local messages and replayed bridge messages were not deduplicated. Workarounds:

1. Pull to refresh chat.
2. Reopen the session.
3. Restart the app if duplicate cached messages persist.

If reproducible, include session ID and bridge logs around the send time.

## Codex exits with an error

Check:

- Codex CLI is installed on the bridge host.
- Codex is authenticated.
- `codex.runtimePath` points to the right executable.
- OMX harness mode is configured only if `omx` is installed.
- The selected project is inside `codex.workspaceRoot`.

Bridge config examples are in [Configuration](configuration.md).

## `codex-auth` missing

Dexyd can show account switching only if `codex-auth` is installed and available on the bridge host. If missing, the app should show guidance. You can still use Dexyd with normal Codex auth if Codex itself is authenticated.

## Diff button does not appear

The **View message diff** button appears under a completed assistant message when the bridge captured changes for that turn.

It may not appear if:

- no files changed;
- the turn was created before per-message diff capture existed;
- the turn was not started from the mobile app;
- the run failed before changes completed;
- the session is external and has no resolvable workspace.

## Android app cannot load script

For development builds, Metro must be reachable. Start Metro with `npm start -- --host 0.0.0.0` from `mobile/dexydMobile`, then run the Android app from another terminal. If you unplug USB, a debug app may still depend on Metro/network for JavaScript loading. A release build bundles JavaScript into the APK.

## TUI does not start

Check Python and dependencies:

```bash
python3 --version
npm run tui
```

If Textual is missing, rerun the installer or install the TUI dependencies used by your setup.

## Database reset

If local bridge state is corrupted and you are willing to lose pairings/session metadata:

1. Stop the bridge.
2. Move `.dexyd/` aside:

```bash
mv .dexyd .dexyd.backup
```

3. Start the bridge.
4. Pair again.

Do not delete `.dexyd/` if you need audit records or trusted-device history.
