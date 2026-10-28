# UABC wire protocols

UABC has three hops for local AI clients. Each hop has exactly one framing and
one envelope; the **command catalog** (method names, params, results, error
codes) is shared by hops B and C, so a command travels end to end unchanged.
Two more paths reuse it: the [relay](#relay-remote-ai-apps) carries hop C over
a WebSocket, and the [built-in assistant](#built-in-assistant-side-panel-port)
sends the same commands over a runtime port.

```
 AI client ──(A) MCP over stdio──▶ uabc mcp ──(B) IPC NDJSON──▶ uabc host ──(C) native messaging──▶ extension
 (Claude Code,                     (spawned by                  (spawned by                          (service worker
  Codex, Cursor…)                   the AI client)               Chrome)                              + content script)
```

| Hop | Transport | Framing | Max message | Who authenticates whom |
|-----|-----------|---------|-------------|------------------------|
| A | stdio of the `uabc mcp` child process | MCP JSON-RPC (newline-delimited) | n/a | The AI client spawned us; nothing to authenticate. |
| B | Unix domain socket (`0600`, in a `0700` dir) / Windows named pipe (DACL: current user + SYSTEM, remote clients rejected) | NDJSON, one object per line | 64 MiB per line | The OS: only the same user can open the endpoint. On Unix the host also checks the peer UID (`SO_PEERCRED`/`getpeereid`). |
| C | stdin/stdout of the host process | Chrome native messaging: `u32` length (native byte order) + UTF-8 JSON | host→extension 1 MiB (Chrome limit), extension→host 64 MiB | Chrome: only extension IDs listed in the host manifest's `allowed_origins` can spawn the host; the host also validates the caller origin passed in `argv[1]`. |

There is **no TCP listener anywhere**. See [ADR-0003](adr/0003-local-ipc-security.md).

---

## Hop A — MCP

Standard MCP, implemented with the official Rust SDK (`rmcp`). The server
negotiates every protocol revision the SDK knows (2024-11-05 … 2026-07-28,
including the handshake-less 2026-07-28 revision). Tools are documented in
[`README.md`](../README.md#tools) and in their JSON schemas (`tools/list`).

Tool failures are returned as `CallToolResult { isError: true }` with a human
readable message **and a recovery hint**, never as JSON-RPC errors, so the
model can see them and recover (e.g. `REF_NOT_FOUND → call browser_get_state`).

---

## Hop B — IPC (NDJSON)

Every line is one JSON object with a `type` field.

### Handshake (client speaks first)

```jsonc
// client → host
{"type":"hello","protocol":1,"client":{"name":"claude-code","version":"2.1.0"},"pid":4242}
// host → client (success)
{"type":"welcome","protocol":1,"session":"s3",
 "instance":{"id":"a1b2c3d4e5f6","label":"Work"},
 "host":{"version":"0.1.0","pid":777},
 "extension":{"id":"opid…","version":"0.1.0"},
 "browser":{"name":"Chrome","version":"142.0.7444.59"}}
// host → client (failure; host closes the connection afterwards)
{"type":"error","error":{"code":"PROTOCOL_MISMATCH","message":"…"}}
```

The client must send `hello` within 5 s. `protocol` is a single integer that is
bumped on breaking changes; minor additions (new methods, new optional fields)
do not bump it. Unknown fields must be ignored by every party.

### Requests

```jsonc
// client → host
{"type":"request","id":7,"method":"input.click","params":{"ref":"12","expect_doc":"9f3a1c2e"}}
// host → client
{"type":"response","id":7,"ok":true,"result":{"navigated":false,"url":"https://…","title":"…"}}
{"type":"response","id":7,"ok":false,"error":{"code":"OBSCURED","message":"…","hint":"…","page_text":true}}
// client → host: best-effort cancellation (e.g. MCP notifications/cancelled)
{"type":"cancel","id":7}
```

`id` is chosen by the client and is only unique per connection. Responses may
arrive out of order. `page_text: true` marks an error message that quotes
page-controlled text (element names, page-chosen hosts); MCP clients receive
such messages fenced as untrusted content. Hints never quote the page.

---

## Hop C — native messaging

The host re-numbers request ids (they are only unique per IPC connection) and
tags each request with the IPC `session`, so the extension can keep
per-AI-client state (current tab, session-scoped site grants) and show the
user *which* AI client is acting.

```jsonc
// extension → host: first message after connectNative()
{"type":"hello","protocol":1,
 "extension":{"id":"opid…","version":"0.1.0"},
 "instance":{"id":"a1b2c3d4e5f6","label":"Work"},
 "browser":{"name":"Chrome","version":"142.0.7444.59"}}
// host → extension
{"type":"welcome","protocol":1,"host":{"version":"0.1.0","pid":777,"endpoint":"/home/u/.uabc/run/a1b2c3d4e5f6.sock"}}

// host → extension: session lifecycle
{"type":"session.open","session":"s3","client":{"name":"claude-code","version":"2.1.0"}}
{"type":"session.close","session":"s3"}

// host → extension: commands
{"type":"request","id":101,"session":"s3","method":"page.snapshot","params":{}}
{"type":"cancel","id":101}
// extension → host
{"type":"response","id":101,"ok":true,"result":{…}}
```

`instance.id` is generated once per browser profile by the extension
(`[a-z0-9]{12}`) and names the IPC endpoint, so `uabc mcp --target work` keeps
working across browser restarts. The host rejects ids that do not match
`^[a-z0-9-]{1,32}$` (they become file names).

### Discovery

Each running host writes `<UABC_HOME>/instances/<instance-id>.json`:

```json
{"instance_id":"a1b2c3d4e5f6","label":"Work","pid":777,
 "endpoint":"/home/u/.uabc/run/a1b2c3d4e5f6.sock",
 "extension_id":"opid…","extension_version":"0.1.0",
 "browser":"Chrome 142.0.7444.59","host_version":"0.1.0","started_at":1761540000}
```

`UABC_HOME` defaults to `~/.uabc` (Unix) or `%LOCALAPPDATA%\uabc` (Windows).
Clients try instances newest-first; `--target <label|id>` pins one.

---

## Relay: remote AI apps

```
 AI app ──MCP Streamable HTTP──▶ uabc relay ◀──WebSocket: hop C messages── extension
         /mcp/<device id>/<connector secret>        /ws (opened by the extension)
```

The extension opens `wss://<relay>/ws` (Origin `chrome-extension://…`; the
relay refuses other origins) and sends, as its first text frame:

```jsonc
{"type":"hello","protocol":1,
 "device":{"id":"<32 hex>","secret":"<64 hex>"},     // id: random, per relay; secret proves it (trust on first use)
 "connector":{"sha256":"<64 hex>"},                   // SHA-256 of the connector secret
 "extension":{"id":"opid…","version":"0.2.0"},
 "instance":{"id":"a1b2c3d4e5f6","label":"Work"},
 "browser":{"name":"Chrome","version":"153.0.0.0"},
 "registration":{"token":"…"}}                       // only if the relay requires an access code
```

The hello must arrive within 10 s and be at most 16 KiB; labels are cut to 64
characters. The extension makes a new device id and secrets whenever the relay
address changes, so no relay ever learns credentials valid at another.

The relay answers `{"type":"welcome","protocol":1,"host":{…}}`, or
`{"type":"error","error":{"code":"UNAUTHORIZED","message":"…"}}` and closes.
After that both sides speak hop C exactly as above (`session.open`,
`session.close`, `request`, `cancel` → extension; `response` → relay); the
extension prefixes the relay's session ids with `remote:`. The extension sends
`{"type":"ping"}` every 20 s and the relay answers `{"type":"pong"}`; a silent
connection is dropped after 75 s. A newer connection of the same device replaces
the older one. Sending a new `connector.sha256` (the extension does this after
*New URL*) revokes the previous connector URL.

Cloud apps use standard MCP Streamable HTTP at
`/mcp/<device id>/<connector secret>`; an unknown device and a wrong secret
both get `404`. Each remote AI client (by MCP `clientInfo` name) becomes its own
session, named `<name> (remote)`; the extension adds "(remote)" itself and
keeps names short and printable. A remote session idle for 10 minutes is
closed and its "allow this time" grants end (the extension also enforces this
on its side).

## Built-in assistant: side-panel port

The side panel connects with `chrome.runtime.connect({name: "uabc-assistant"})`.
The service worker accepts the port only from UABC's own pages and opens one
AI session per port (`session.open` equivalent); closing the panel closes it.

```jsonc
// panel → service worker
{"type":"client","name":"UABC assistant (claude-opus-5-5)"}  // the name shown in prompts
{"type":"call","id":1,"method":"page.snapshot","params":{}}
{"type":"cancel","id":1}
{"type":"ping"}                                              // every 20 s, keeps the worker alive
// service worker → panel
{"type":"hello","session":"assistant-1a2b3c4d"}
{"type":"result","id":1,"ok":true,"result":{…}}
{"type":"result","id":1,"ok":false,"error":{"code":"STALE_REF","message":"…","hint":"…"}}
```

---

## Command catalog

Every page-level command accepts an optional `tab_id`; the default is the
session's *current tab* (the tab most recently opened or selected by that AI
session). Agents can only see and touch tabs inside the **UABC tab group**
([ADR-0004](adr/0004-agent-workspace-and-site-grants.md)).

| Method | Params | Result |
|--------|--------|--------|
| `browser.status` | – | `{paused, mode, input_mode, sessions, tabs[], current_tab, grants[]}`; `sessions` is the number of connected AI clients (no names: those are none of another client's business) |
| `tabs.list` | – | `{tabs:[{id,title,url,active,current,approved}]}`; for tabs whose site is not approved, `url` is the origin only and `title` is empty |
| `tabs.open` | `url?`, `background?` | `{tab}` |
| `tabs.select` | `tab_id` | `{tab}` |
| `tabs.close` | `tab_id?` | `{closed}` |
| `page.navigate` | `url?` \| `history?: back\|forward\|reload` | `{tab_id,url,title,status}` |
| `page.snapshot` | `mode?: viewport\|full`, `max_elements?`, `include_text?`, `max_text?` | `{tab_id,doc,url,title,viewport,scroll,elements[],counts,text?}` |
| `page.screenshot` | `marks?`, `full_page?`, `format?: jpeg\|png`, `quality?` | `{tab_id,doc?,mime,data(base64),marks?}` |
| `input.click` | `ref?` \| `selector?` \| `x?,y?`; `button?`, `click_count?`, `modifiers?`, `expect_doc?` | `{navigated,url,title}` |
| `input.type` | `ref?` \| `selector?`; `text`, `clear?`, `submit?`, `expect_doc?` | `{navigated,url,title,value?}` |
| `input.key` | `keys` (e.g. `Enter`, `Control+A`, `Shift+Tab`) | `{navigated,url,title}` |
| `input.select` | `ref` \| `selector`; `values[]`, `expect_doc?` | `{selected[]}` |
| `page.scroll` | `direction: up\|down\|left\|right`, `amount?` (px, default one screen), `ref?` | `{scroll:{x,y,max_x,max_y}}` |
| `page.wait_for` | `text?`, `text_gone?`, `timeout_ms?` | `{found,elapsed_ms}` |

### Element refs and staleness

`page.snapshot` assigns each interactive element a small integer ref (`[12]`),
stable for the lifetime of the document. Each snapshot also returns `doc`, a
random id of the current document. `uabc mcp` remembers the last `doc` per tab
and sends it as `expect_doc` with every ref-based action; the content script
refuses refs from a previous document (`STALE_REF`) instead of clicking
whatever element happens to have the same number on the new page.

### Error codes

| Code | Meaning | Typical recovery |
|------|---------|------------------|
| `HOST_NOT_RUNNING` | No browser bridge is running (`uabc mcp` side). | Open Chrome with the extension enabled; run `uabc install`. |
| `EXTENSION_DISCONNECTED` | The host lost the extension. | Same as above. |
| `PROTOCOL_MISMATCH` | Incompatible versions. | Update extension and `uabc` together. |
| `PAUSED` | The user paused AI control. | Ask the user to resume. |
| `NO_TAB` | Session has no current tab. | `browser_tabs` with `new` or `select`. |
| `TAB_NOT_SHARED` | Tab is outside the UABC tab group. | Ask the user to share it. |
| `BLOCKED_URL` | Scheme or URL is never allowed (`chrome://`, `file://`, `javascript:` …). | Use another URL. |
| `PERMISSION_DENIED` | User denied the site, or mode is pre-approved-only. | Ask the user. |
| `APPROVAL_TIMEOUT` | User did not answer the site prompt in time. | Ask the user, retry. |
| `REF_NOT_FOUND` / `STALE_REF` | Ref unknown, detached, or from an old document. | `browser_get_state` again. |
| `NOT_INTERACTABLE` | Hidden, disabled, zero-size, or wrong element type. | Pick another element. |
| `OBSCURED` | Another element covers the target (message names it). | Dismiss the overlay first. |
| `SENSITIVE_FIELD` | Password / payment field. UABC never types into or reads them. | The user fills it in. |
| `NO_SUCH_OPTION` | `input.select` value matches no option (the message lists the available ones). | Use an available label. |
| `CDP_UNAVAILABLE` | Trusted input unavailable (debugger refused / detached by user). | Retry; user may switch input mode. |
| `TIMEOUT` | Command exceeded its deadline. | Retry or wait. |
| `INVALID_PARAMS` / `UNKNOWN_METHOD` / `INTERNAL` | Bugs or misuse. | Fix the call. |
