# Hermes Iroh App

A standalone Electron desktop client for the Hermes Agent
[`Iroh-channel`](https://github.com/Dima-Migunov/hermes-iroh-channel) plugin. It connects
directly to the server over Iroh using ALPN `iroh-channel/1`, keeps its own stable identity, and
streams agent responses into a local chat UI. Hermes Agent, Python, and the server runtime do
not need to be installed on the client machine.

## Prerequisites

- **Node.js ≥ 22.22.2** and npm for building from source.
- A running Hermes Agent server with the
  [`Iroh-channel` plugin](https://github.com/Dima-Migunov/hermes-iroh-channel) enabled, plus
  either its `NodeTicket` or its `NodeId`.
- A client `NodeId` added to the server allowlist with `/iroh_allow <client_node_id>`.

Platform support follows the prebuilt `@number0/iroh@1.2.0` binaries:

| Platform | Architectures | Notes |
| --- | --- | --- |
| Windows | x64, arm64 | NSIS installer |
| macOS | arm64 only | No Intel (x64) prebuilt binary exists for 1.2.0 |
| Linux | x64, arm64 | glibc and musl; AppImage and deb |

If the native module cannot load on the host (for example macOS Intel), the app reports a
startup error instead of running without Iroh.

## Server plugin

The app is only the client half. The Hermes Agent host must run the `Iroh-channel` platform
plugin, which is installed through the Hermes plugin manager from its repository:

```bash
hermes plugins install Dima-Migunov/hermes-iroh-channel
```

Repository and full installation guide:
<https://github.com/Dima-Migunov/hermes-iroh-channel>

The plugin is distributed as a Hermes plugin, not as a separate archive; the command clones it
from GitHub into `~/.hermes/plugins/iroh-channel/` and leaves it disabled. Enable the plugin and
the `iroh` platform, then restart the gateway from outside the agent session:

```bash
hermes plugins enable iroh-channel
hermes config set gateway.platforms.iroh.enabled true
```

See the plugin README's
[installation section](https://github.com/Dima-Migunov/hermes-iroh-channel#installation) for
the restart command for your host, `/iroh_info`, and troubleshooting.

## Download

Prebuilt installers are published on the
[GitHub Releases page](https://github.com/Dima-Migunov/hermes-iroh-app/releases). Download the
asset that matches your operating system and architecture.

| Platform | Architecture | Assets |
| --- | --- | --- |
| Windows | x64, arm64 | NSIS installer (`.exe`) |
| macOS | arm64 (Apple Silicon) | `.dmg` disk image and `.zip` archive |
| Linux | x64, arm64 | `.AppImage` and `.deb` |

Asset names follow `hermes-iroh-app-<version>-<os>-<arch>.<ext>`, where `<os>` is `win`,
`mac`, or `linux`. Linux assets use the native package tokens: `x86_64` for AppImage and `amd64`
for deb. For version `0.4.0` the release contains:

```text
hermes-iroh-app-0.4.0-win-x64.exe
hermes-iroh-app-0.4.0-win-arm64.exe
hermes-iroh-app-0.4.0-mac-arm64.dmg
hermes-iroh-app-0.4.0-mac-arm64.zip
hermes-iroh-app-0.4.0-linux-x86_64.AppImage
hermes-iroh-app-0.4.0-linux-arm64.AppImage
hermes-iroh-app-0.4.0-linux-amd64.deb
hermes-iroh-app-0.4.0-linux-arm64.deb
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
xattr -dr com.apple.quarantine "/Applications/Hermes Iroh App.app"
```

**Windows.** SmartScreen may show "Windows protected your PC". Choose **More info**, then
**Run anyway**. The installer reports an unknown publisher.

**Linux AppImage.** Make the file executable and run it (use `x86_64` or `arm64` for `<arch>`):

```bash
chmod +x hermes-iroh-app-<version>-linux-<arch>.AppImage
./hermes-iroh-app-<version>-linux-<arch>.AppImage
```

**Linux deb.** Install with `dpkg` (use `amd64` or `arm64` for `<arch>`):

```bash
sudo dpkg -i hermes-iroh-app-<version>-linux-<arch>.deb
```

## Build and run from source

To run from source instead of using a downloaded build:

```bash
cd hermes-iroh-app
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

1. Start Hermes Agent with the `Iroh-channel` plugin enabled (see [Server plugin](#server-plugin))
   and obtain either the server `NodeTicket` or the server `NodeId`. A ticket is preferred
   because it already carries reachable addresses; a bare `NodeId` relies on Iroh discovery.
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
   and can be copied as raw Markdown from the completed message. To stop it — from submission
   while waiting for the first reply through streaming — choose the stop square (■) in place of
   the send arrow (↑) or press `Escape`.

Provide a server target: either an endpoint ticket or a server NodeId. A ticket is preferred and
wins when both fields are filled in, in which case the NodeId is dropped. A save with neither
target, or with an unparseable target, is rejected and the previously saved settings stay in effect.

### Stopping a response

From the moment a prompt is submitted — including while waiting for the assistant's first
frame — the composer's primary action shows a stop square (■) in place of the send arrow (↑),
and `Escape` triggers the same action from anywhere in the window. The action stays enabled
even when the field is empty; activating it with no submittable text sends nothing. The message
field keeps focus and stays editable while a response is in flight, so the next message can be
drafted; pressing `Enter` does not submit it until generation ends. Stopping closes the receive
side of the prompt stream, releases the client's single-prompt lock immediately, and ignores
every later frame from that request. The partial answer stays in the transcript with status
`interrupted`, no error banner is shown, and the composer is available again right away.

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
| Linux | `~/.config/hermes-iroh-app/` |
| macOS | `~/Library/Application Support/hermes-iroh-app/` |
| Windows | `%APPDATA%\hermes-iroh-app\` |

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
{"type":"done","metadata":{"schema":1,"generated_at":"2026-11-21T12:00:00.000Z","latency_ms":812}}
{"type":"error","message":"reason"}
```

- `start` is required before deltas; the echoed session id must match the request.
- `delta.content` is appended in arrival order.
- `done` and `error` are terminal. Unknown frame types are ignored.
- `done` may carry an optional `metadata` object. A bare `{"type":"done"}` remains valid and
  completes the response exactly as before. `error` never carries metadata.
- The client shows the latest completed response's model, compact context, and estimated cost in
  small right-aligned text under the message field. Metadata is never rendered inside transcript
  messages.
- Malformed JSON, invalid UTF-8, missing fields on known frames, and lines over 1 MiB are
  protocol errors that terminate the request.

### Response metadata

A successful `done` frame may include `metadata` describing the turn. The server caps it at
4096 bytes and omits it when no metadata is available.

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | integer | Metadata version; currently `1` |
| `generated_at` | string | ISO-8601 UTC timestamp when the terminal frame was built |
| `latency_ms` | integer | Milliseconds from prompt acceptance to the terminal frame |
| `model` | string | Model that produced the turn, when reported |
| `provider` | string | Provider for that model, when reported |
| `usage` | object | Per-turn token counts: `input_tokens`, `output_tokens`, `total_tokens`, and `reasoning_tokens`, `cache_read_tokens`, `cache_write_tokens` when available |
| `session_usage` | object | Cumulative conversation counters: `input_tokens`, `output_tokens`, `total_tokens`, `api_calls`, `estimated_cost_usd`, `cost_status`, `cost_source`, and the context fields `context_tokens`, `context_length`, `context_percent` when available |
| `balance` | object | Account view: `provider`, `remaining_micros`, `remaining_usd`, `subscription_micros`, `subscription_usd`, `subscription_limit_usd`, `purchased_micros`, `purchased_usd`, `paid_access`, `as_of_ms`, and an optional `plan_gauge` with `id`, `label`, `used_bp`, `resets_at_ms` |

- `schema`, `generated_at`, and `latency_ms` are always present; every other field is omitted
  when the server does not expose the value. `usage` describes one turn while `session_usage`
  describes the whole conversation.
- Unknown fields at every level are ignored and a newer integer `schema` is accepted, so the
  metadata can grow without a protocol revision.
- Metadata that is not an object or lacks a valid required field is discarded. The turn still
  completes with a bare `done` and no protocol error; metadata on an `error` frame is ignored.
- The client stores recognized metadata with the completed assistant message, so the composer
  status survives session switches and restarts.
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

1. Start Hermes Agent with the `Iroh-channel` plugin installed (see [Server plugin](#server-plugin)).
   Note its ticket or NodeId.
2. Launch `npm run dev` in this directory. Expected: a window opens with the title
   `Hermes Iroh App — Disconnected`, no application menu bar, a sidebar with the session list and a
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
   input does nothing, the primary action stays enabled (showing the stop square ■ from
   submission until `done`, `error`, or a stop), and the message field keeps focus and stays
   editable while a response is in flight, with only submission blocked.
10. Stop the server and send another prompt. Expected: the request fails with a timeout or
    connection error, the user message remains marked failed, and the composer becomes
    available again.
11. Resize the window to 800×600 and tab through the sidebar **Settings** action, the settings
    page controls, the session list, message copy buttons, and the composer. Expected: every
    control is reachable, focus is visible, and the connection state is conveyed by text in the
    settings status indicator and the window title as well as color.
12. Start a long response, then choose the stop button (■); repeat with `Escape`. Expected: the
    primary action shows the stop square while generating, the partial answer stays visible and
    is marked interrupted, no error banner appears, and another prompt can be sent immediately.
    If the server briefly answers `session_busy`, retrying after a moment succeeds.
13. With `Iroh-channel` plugin 1.2.0 or newer running on the server, send a prompt. Expected:
    small right-aligned text under the message field shows the model, compact context, and
    estimated cost from the latest completed response, for example
    `Qwen/Qwen3.7-Flash 217.4K / 1M (22%) $0.00`. The completed message itself shows no metadata
    text, and absent values are omitted rather than shown as `null`, `0`, or a dash.
14. Restart the desktop app and reopen the session. Expected: the composer status shows the
    restored values. Switch to another session and back: expected, the status follows the active
    session and is absent when that session has no completed metadata.
15. Connect to a server that sends a bare `{"type":"done"}` (an older plugin or no available
    metadata). Expected: the response completes normally, no composer status appears, and no error
    appears. Stop a response mid-stream against a metadata-capable server: expected, the partial
    message is marked interrupted and the composer status keeps its previous values.

Automated checks (`npm test`) cover the same wire contract against a real in-process Iroh
endpoint with `presetMinimal`: exact prompt bytes, start/delta/done ordering, server errors,
early close with the allowlist hint, malformed JSON, and prompt-lock release. They skip with a
diagnostic when the native module is unavailable.
