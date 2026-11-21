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

## Install and run

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
2. Start the desktop client. The **Client NodeId** is shown in the Connection panel. It is
   stable across restarts and is derived from `userData/client.key`.
3. Copy the client `NodeId` and allow it on the server:

   ```text
   /iroh_allow <client_node_id>
   ```

4. Paste the server ticket (or NodeId) into the settings panel. If the server uses a custom
   relay, enter its URL in **Relay URL**; leave it blank to use the default Iroh relay mode.
5. Choose **Save & connect**. The status indicator changes from `Connecting…` to `Connected`.
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
| Connection closed before a response | The client was likely rejected. Run `/iroh_allow <client_node_id>` for the NodeId shown in settings. |
| Connection reset / refused | The server or relay dropped the connection. Retry, check the relay URL, and confirm the server is online. |
| `startup reports an identity error` | `client.key` is unreadable or not 32 bytes. Restore the backup or deliberately delete it to create a new identity. |
| Missing native module | `@number0/iroh` could not load on this OS/arch, usually macOS Intel. Use a supported platform. |
| Settings will not save | A target is required and the ticket/NodeId must parse. If both fields are filled the ticket wins and the NodeId is dropped. The last valid settings remain active. |
| `session_busy` after stopping | The server has not released its session slot yet. Wait a moment and send the prompt again; the client lock is already free. |
| History notice after launch | A history file was invalid; it was preserved as `*.corrupt-*` and that session starts empty. |

## Manual end-to-end verification

1. Start Hermes Agent with the `Iroh-channel` plugin. Note its ticket or NodeId.
2. Launch `npm run dev` in this directory. Expected: a window opens showing a `Disconnected`
   status and a non-empty client NodeId.
3. Copy the client NodeId and run `/iroh_allow <client_node_id>` on the server. Expected: the
   server confirms the allowlist entry.
4. Enter the server ticket (or NodeId), choose **Save & connect**. Expected: status becomes
   `Connected`; restarting the app restores the saved settings and NodeId.
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
11. Resize the window to 800×600 and tab through the settings, session list, message copy
    buttons, and composer. Expected: every control is reachable, focus is visible, and the
    connection state is conveyed by text as well as color.
12. Start a long response, then choose **Stop**; repeat with `Escape`. Expected: the primary
    action reads **Stop** while generating, the partial answer stays visible and is marked
    interrupted, no error banner appears, and another prompt can be sent immediately. If the
    server briefly answers `session_busy`, retrying after a moment succeeds.

Automated checks (`npm test`) cover the same wire contract against a real in-process Iroh
endpoint with `presetMinimal`: exact prompt bytes, start/delta/done ordering, server errors,
early close with the allowlist hint, malformed JSON, and prompt-lock release. They skip with a
diagnostic when the native module is unavailable.
