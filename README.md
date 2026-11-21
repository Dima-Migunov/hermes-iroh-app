# Iroh Channel Desktop

A standalone Electron desktop client for the Hermes Agent `Iroh-channel` plugin. It connects
directly to the server over Iroh using ALPN `iroh-channel/1`, keeps its own stable identity, and
streams agent responses into a local chat UI. Hermes Agent, Python, and the server runtime do
not need to be installed on the client machine.

## Prerequisites

- **Node.js ≥ 20.3** and npm for building from source.
- A running Hermes Agent server with the `Iroh-channel` plugin enabled, plus either its
  `NodeTicket` or its `NodeId`.
- A client `NodeId` added to the server allowlist with `/iroh_allow <client_node_id>`.

Platform support follows the prebuilt `@number0/iroh@1.2.0` binaries:

| Platform | Architectures | Notes |
| --- | --- | --- |
| Windows | x64, arm64 | NSIS installer |
| macOS | arm64 only | No Intel (x64) prebuilt binary exists for 1.2.0 |
| Linux | x64, arm64 | glibc and musl; AppImage and deb |

If the native module cannot load on the host (for example macOS Intel), the app reports a
startup error instead of running without Iroh.

## Download

Prebuilt installers are published on the
[GitHub Releases page](https://github.com/Dima-Migunov/hermes-iroh-app/releases). Download the
asset that matches your operating system and architecture.

| Platform | Architecture | Assets |
| --- | --- | --- |
| Windows | x64, arm64 | NSIS installer (`.exe`) |
| macOS | arm64 (Apple Silicon) | `.dmg` disk image and `.zip` archive |
| Linux | x64, arm64 | `.AppImage` and `.deb` |

Asset names follow `iroh-channel-desktop-<version>-<os>-<arch>.<ext>`, where `<os>` is `win`,
`mac`, or `linux`. Linux assets use the native package tokens: `x86_64` for AppImage and `amd64`
for deb. For version `0.2.0` the release contains:

```text
iroh-channel-desktop-0.2.0-win-x64.exe
iroh-channel-desktop-0.2.0-win-arm64.exe
iroh-channel-desktop-0.2.0-mac-arm64.dmg
iroh-channel-desktop-0.2.0-mac-arm64.zip
iroh-channel-desktop-0.2.0-linux-x86_64.AppImage
iroh-channel-desktop-0.2.0-linux-arm64.AppImage
iroh-channel-desktop-0.2.0-linux-amd64.deb
iroh-channel-desktop-0.2.0-linux-arm64.deb
SHA256SUMS.txt
```

Download `SHA256SUMS.txt` next to the installers and verify the files before installing:

```bash
sha256sum -c SHA256SUMS.txt        # Linux
shasum -a 256 -c SHA256SUMS.txt    # macOS
```

### Opening unsigned builds

Releases are not signed by a verified publisher. macOS builds are ad-hoc signed but not
notarized, and Windows builds are certificate-unsigned, so both systems warn on first launch.

**macOS.** Gatekeeper blocks the unnotarized app on first launch. Right-click (or Control-click)
the app, choose **Open**, then confirm with **Open** again. To clear the quarantine attribute
instead:

```bash
xattr -dr com.apple.quarantine "/Applications/Iroh Channel.app"
```

**Windows.** SmartScreen may show "Windows protected your PC". Choose **More info**, then
**Run anyway**. The installer reports an unknown publisher.

**Linux AppImage.** Make the file executable and run it (use `x86_64` or `arm64` for `<arch>`):

```bash
chmod +x iroh-channel-desktop-<version>-linux-<arch>.AppImage
./iroh-channel-desktop-<version>-linux-<arch>.AppImage
```

**Linux deb.** Install with `dpkg` (use `amd64` or `arm64` for `<arch>`):

```bash
sudo dpkg -i iroh-channel-desktop-<version>-linux-<arch>.deb
```

## Build and run from source

To run from source instead of using a downloaded build:

```bash
cd iroh-channel-desktop
npm install
npm run dev        # Electron + Vite with hot reload
npm run typecheck  # TypeScript for main/preload and renderer
npm test           # Vitest unit + local Iroh integration tests
npm run build      # compile to out/
npm run package    # build installers for the current platform into dist/
```

`npm run package` produces the configured target for the OS it runs on (NSIS on Windows,
DMG/ZIP on macOS, AppImage/deb on Linux). macOS Intel is intentionally absent from the build
targets; adding it requires an upstream prebuilt binary or a Rust toolchain build pipeline.

## Connect to a server

1. Start Hermes Agent with the `Iroh-channel` plugin enabled and obtain either the server
   `NodeTicket` or the server `NodeId`. A ticket is preferred because it already carries
   reachable addresses; a bare `NodeId` relies on Iroh discovery.
2. Start the desktop client and open **Settings** from the sidebar. The **Client NodeId** is
   shown under **Connection** on the settings page. It is stable across restarts and is derived
   from `userData/client.key`.
3. Copy the client `NodeId` and allow it on the server:

   ```text
   /iroh_allow <client_node_id>
   ```

4. Paste the server ticket (or NodeId) into the server target field on the settings page. If the
   server uses a custom relay, enter its URL in **Relay URL**; leave it blank to use the default
   Iroh relay mode.
5. Choose **Save & connect**. The status indicator on the settings page changes from `Connecting…`
   to `Connected`, and the window title follows the live connection state. Choose **Back** to
   return to the chat view.
6. Send a message. The reply streams in token by token, renders Markdown and highlighted code,
   and can be copied as raw Markdown from the completed message. To stop it early, choose
   **Stop** in place of **Send** or press `Escape`.

Provide a server target: either an endpoint ticket or a server NodeId. A ticket is preferred and
wins when both fields are filled in, in which case the NodeId is dropped. A save with neither
target, or with an unparseable target, is rejected and the previously saved settings stay in effect.

### Stopping a response

While a response is generating, the composer's primary action becomes **Stop**, and `Escape`
triggers the same action from anywhere in the window. Stopping closes the receive side of the
prompt stream, releases the client's single-prompt lock immediately, and ignores every later
frame from that request. The partial answer stays in the transcript with status `interrupted`,
no error banner is shown, and the composer is available again right away.

The Hermes turn may continue on the server after a stop; its output is discarded and never
reaches the client. If a prompt sent immediately after a stop is rejected with `session_busy`,
wait a moment and send it again. The client lock is already free; only the server's session slot
is still settling.

### Relay configuration

- **Relay URL empty** — `RelayMode.defaultMode()` (the n0 production relay map).
- **Relay URL set** — `RelayMode.customFromUrls([relayUrl])` for the *client's* endpoint.
  Use `https://…` or `http://…`.
- A ticket already contains the server's addresses. A bare `NodeId` is resolved through
  discovery, with the configured relay URL supplied as an address hint.

## Local data and key backup

Files live under Electron's `app.getPath('userData')`:

| OS | Path |
| --- | --- |
| Linux | `~/.config/iroh-channel-desktop/` |
| macOS | `~/Library/Application Support/iroh-channel-desktop/` |
| Windows | `%APPDATA%\iroh-channel-desktop\` |

```text
userData/
  client.key                 # raw 32-byte Ed25519 secret key (mode 0600 where supported)
  config.json                # server target, optional relay URL, version
  history/
    index.json               # active session + session metadata
    <sessionId>.json         # per-session messages
```

**`client.key` is the client identity.** Back it up if the machine is replaced. Deleting or
losing it creates a new NodeId that must be allowlisted again. If the file exists but is
unreadable or not exactly 32 bytes, the app reports an actionable identity error and never
overwrites it. Remove the file deliberately to reset the identity.

History is grouped per session and written atomically. Streaming responses are debounced while
they grow, flushed on terminal outcomes and on quit, and any message still marked `streaming`
at startup is restored as `interrupted`. Invalid history files are preserved next to the
original as `*.corrupt-<timestamp>` and the affected session starts empty with a notice.

## Security model

- The renderer is sandboxed with `contextIsolation: true`, `nodeIntegration: false`, and
  `sandbox: true`. It has no Node.js APIs, filesystem access, key material, or Iroh objects.
- Preload exposes one frozen `window.irohChannel` object through `contextBridge`. It contains
  only the documented operations; there is no generic IPC invoke.
- Main accepts only a fixed channel allowlist, verifies the sender frame belongs to the
  application window, and validates every payload with Zod before touching storage, keys, or
  the network.
- Only locally packaged renderer content is loaded. New windows are denied, navigation outside
  the app origin is blocked, and the production CSP disallows remote scripts and connections.
  Development adds only the Vite HMR origin/WebSocket allowances.
- The secret key is never logged, serialized over IPC, or written outside `client.key`. File
  permissions plus full-disk encryption are the local confidentiality boundary.

## Protocol summary

One bidirectional QUIC stream per prompt over an Iroh connection using ALPN `iroh-channel/1`.

Client request (exactly one line, then the write side is finished):

```json
{"type":"prompt","session_id":"<session id>","text":"<message>"}
```

Server response (JSON Lines):

```json
{"type":"start","session_id":"<session id>"}
{"type":"delta","content":"token"}
{"type":"done"}
{"type":"error","message":"reason"}
```

- `start` is required before deltas; the echoed session id must match the request.
- `delta.content` is appended in arrival order.
- `done` and `error` are terminal. Unknown frame types are ignored.
- Malformed JSON, invalid UTF-8, missing fields on known frames, and lines over 1 MiB are
  protocol errors that terminate the request.
- EOF before a terminal frame becomes a `connection-closed` error that mentions the allowlist.
- A user-initiated stop closes the receive side of the active stream and adds no protocol frame.
  Late `delta`, `done`, or `error` frames from that request are ignored, the single-prompt lock
  is released immediately, and the partial message is stored as `interrupted`.
- At most one prompt is in flight. A second submission is rejected as busy.
- Connection reuse is attempted across prompts; if the server closes the connection, the next
  prompt reconnects before sending.

## Troubleshooting

| Symptom | Meaning and action |
| --- | --- |
| `Connecting…` then timeout | The server was not reachable within 30 seconds. Re-check the ticket/NodeId, relay URL, and that the plugin is running. |
| Connection closed before a response | The client was likely rejected. Run `/iroh_allow <client_node_id>` for the NodeId shown on the settings page. |
| Connection reset / refused | The server or relay dropped the connection. Retry, check the relay URL, and confirm the server is online. |
| `startup reports an identity error` | `client.key` is unreadable or not 32 bytes. Restore the backup or deliberately delete it to create a new identity. |
| Missing native module | `@number0/iroh` could not load on this OS/arch, usually macOS Intel. Use a supported platform. |
| Settings will not save | A target is required and the ticket/NodeId must parse. If both fields are filled the ticket wins and the NodeId is dropped. The last valid settings remain active. |
| `session_busy` after stopping | The server has not released its session slot yet. Wait a moment and send the prompt again; the client lock is already free. |
| History notice after launch | A history file was invalid; it was preserved as `*.corrupt-*` and that session starts empty. |

## Publishing a release

The release workflow (`.github/workflows/release.yml`) runs on any tag matching `v*`:

1. Bump `version` in `package.json` and commit the change.
2. Create and push a matching tag:

   ```bash
   git tag v0.2.1
   git push origin v0.2.1
   ```

3. The workflow fails before packaging when the tag does not equal
   `v$(node -p "require('./package.json').version")`. On success it runs type checking and the
   test suite, builds Windows x64/arm64, macOS arm64, and Linux x64/arm64 installers, and
   publishes one release with all eight installers plus `SHA256SUMS.txt`.

For a prerelease, use a semver prerelease suffix; the GitHub Release is marked as a prerelease:

```bash
git tag v0.2.1-rc.1
git push origin v0.2.1-rc.1
```

Re-run a failed workflow from the Actions page for the same tag. The draft-first flow reuses an
existing draft or published release and re-uploads assets with `--clobber`.

To roll back a release, delete the GitHub Release and the tag:

```bash
gh release delete v0.2.1 --yes
git push origin --delete v0.2.1
git tag --delete v0.2.1
```

## Manual end-to-end verification

1. Start Hermes Agent with the `Iroh-channel` plugin. Note its ticket or NodeId.
2. Launch `npm run dev` in this directory. Expected: a window opens with the title
   `Iroh Channel — Disconnected`, no application menu bar, a sidebar with the session list and a
   **Settings** action, and a settings page showing a `Disconnected` status and a non-empty
   client NodeId.
3. Copy the client NodeId from the settings page and run `/iroh_allow <client_node_id>` on the
   server. Expected: the server confirms the allowlist entry.
4. On the settings page, enter the server ticket (or NodeId), choose **Save & connect**.
   Expected: the status indicator and window title become `Connected`; restarting the app
   restores the saved settings and NodeId.
5. Send `Write a short Python function and explain it`. Expected: the user message appears
   immediately; the assistant message appears when streaming starts and grows in place;
   Markdown and a highlighted fenced code block render; embedded HTML is escaped.
6. Use **Copy answer**. Expected: the clipboard contains the original Markdown, including the
   code fence, not the rendered HTML.
7. Create a new chat, send a different message, then switch back. Expected: transcripts are
   isolated, and session titles derive from the first message of each chat.
8. Quit and relaunch. Expected: the active session and both transcripts are restored. If the
   app was quit mid-stream, the partial answer is shown as interrupted.
9. Verify composer behavior: `Enter` sends, `Shift+Enter` inserts a newline, whitespace-only
   input does nothing, and the composer is disabled until `done`, `error`, or a stop.
10. Stop the server and send another prompt. Expected: the request fails with a timeout or
    connection error, the user message remains marked failed, and the composer becomes
    available again.
11. Resize the window to 800×600 and tab through the sidebar **Settings** action, the settings
    page controls, the session list, message copy buttons, and the composer. Expected: every
    control is reachable, focus is visible, and the connection state is conveyed by text in the
    settings status indicator and the window title as well as color.
12. Start a long response, then choose **Stop**; repeat with `Escape`. Expected: the primary
    action reads **Stop** while generating, the partial answer stays visible and is marked
    interrupted, no error banner appears, and another prompt can be sent immediately. If the
    server briefly answers `session_busy`, retrying after a moment succeeds.

Automated checks (`npm test`) cover the same wire contract against a real in-process Iroh
endpoint with `presetMinimal`: exact prompt bytes, start/delta/done ordering, server errors,
early close with the allowlist hint, malformed JSON, and prompt-lock release. They skip with a
diagnostic when the native module is unavailable.
