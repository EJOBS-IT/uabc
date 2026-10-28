# UABC — Universal AI Browser Controller

**Let AI use your real browser — your logins, your 2FA, your tabs — with your permission for every site.**

UABC is a Chrome extension plus a small program (`uabc`). It gives AI three
ways into your own browser profile, all behind the same safety gate:

| Use it from… | How | Needs |
|---|---|---|
| **The built-in assistant** | A chat in Chrome's side panel (**Alt+Shift+U**) that works with your own API key: OpenAI, Anthropic (Claude), Google Gemini (AI Studio key), OpenRouter (hundreds of models), or a local model in Ollama, LM Studio or any OpenAI-compatible server. | Only the extension |
| **Your AI tools** | A standard [MCP](https://modelcontextprotocol.io) server for Claude Code, OpenAI Codex, Antigravity, Cursor, Gemini CLI, VS Code, LM Studio, Goose … | The `uabc` bridge on this computer |
| **AI apps in the cloud** | A secret connector URL for Claude custom connectors, ChatGPT developer mode, Gemini Enterprise and any app that accepts a remote MCP server. | A relay (`uabc relay`) you run or trust |

> **Status: alpha.** Everything described here works and is covered by
> end-to-end tests. It is not yet on the Chrome Web Store; build it from
> source. See [ROADMAP.md](ROADMAP.md).

## Why

- **Real sessions.** Playwright and Selenium start empty profiles, and since
  Chrome 136 remote debugging is refused on your default profile. UABC works
  *inside* your normal browser, so Gmail, dashboards and intranet apps are
  already signed in.
- **Any AI, no lock-in.** Bring your own key and pick any model, plug in any
  MCP client, or reach the browser from a cloud chat app.
- **Safe to hand your real profile to.** AI only sees tabs you share, needs your
  approval for every new website, never touches password or payment fields, and
  stops instantly with one click or **Alt+Shift+K**. Read [SECURITY.md](SECURITY.md).
- **Bangla and every other script.** Text goes through Chrome's input pipeline
  (`Input.insertText`), so `আমার সোনার বাংলা` types correctly, even in rich
  editors. The assistant answers in the language you write in.

## How it works

```
 side panel chat ──(your API key)──▶ OpenAI · Anthropic · Gemini · OpenRouter · Ollama …
        │
        │ port            Claude Code, Codex …                Claude.ai, ChatGPT …
        │                       │ MCP stdio                         │ MCP over HTTPS
        │                       ▼                                   ▼
        │                   uabc mcp ─IPC─▶ uabc host          uabc relay (optional)
        │                                      │ native              ▲ WebSocket,
        ▼                                      ▼ messaging           │ opened by the browser
 ┌──────────────────────────────────────────────────────────────────────┐
 │ extension service worker — one gate for every AI client:             │
 │ UABC tab group · per-site approval · sensitive fields · Stop · log    │
 └──────────────────────────────────────────────────────────────────────┘
                                   ▼
                          your shared tabs
```

There is no listening port on your computer: the browser starts `uabc`, and
only processes of your own OS user can reach it. The relay is opt-in; the
browser connects *out* to it. Details: [docs/architecture.md](docs/architecture.md).

## Quick start (from source)

Requirements: Node ≥ 20, Chrome/Chromium/Edge/Brave 116+, and Rust ≥ 1.88 for
the `uabc` program.

```sh
git clone https://github.com/EJOBS-IT/uabc && cd uabc
npm ci
npm run build:ext            # → extension/dist
cargo build --release        # → target/release/uabc
```

**Load the extension:** `chrome://extensions` → *Developer mode* → *Load
unpacked* → `extension/dist`. (Branded Chrome 137+ ignores `--load-extension`.)

### A. Chat with the built-in assistant

1. In UABC's settings (opened on install) paste an API key under
   *Built-in AI assistant*. UABC checks it and loads the provider's models. For
   Ollama or LM Studio, add an *OpenAI-compatible endpoint* such as
   `http://localhost:11434/v1`.
2. Press **Alt+Shift+U** (or *Open the assistant* in the toolbar popup), pick a
   model and ask, for example: *"bbc.com/bangla খুলে প্রধান খবরটা সংক্ষেপে বলো"*.
3. Approve the site when asked. Each step the assistant takes is listed in the
   chat; *Stop* ends it.

More: [docs/assistant.md](docs/assistant.md).

### B. Connect your AI tools (MCP)

```sh
./target/release/uabc install --dev        # register the bridge (--dev trusts the unpacked build)
./target/release/uabc config claude-code   # or: codex, antigravity, cursor, gemini, vscode, generic
# claude mcp add --scope user uabc -- "/path/to/uabc" mcp
```

Then ask your agent something like *"Open https://news.ycombinator.com and
summarise the top 5 stories."* `uabc status` shows registrations and running
browsers; `uabc call tabs.list` sends a raw command.

### C. Use the browser from Claude.ai or ChatGPT

1. Run a relay behind HTTPS: `uabc relay --listen 127.0.0.1:8787` plus Caddy,
   nginx or a tunnel ([docs/relay.md](docs/relay.md)).
2. In UABC's settings, *Use this browser from Claude, ChatGPT and other AI apps*:
   turn it on, enter the relay address and copy the **connector URL**.
3. Claude: add a custom connector with that URL. ChatGPT: turn on developer
   mode and add a connector with that URL and no authentication (click and type
   need a plan with full MCP write actions; see the guide).

The URL works like a password; *New URL* revokes it. New sites still need your
approval in the browser.

## Tools

The same eleven tools for the assistant, MCP clients and cloud apps:

| Tool | What it does |
|---|---|
| `browser_status` | Connection, pause state, shared tabs, approved sites. |
| `browser_tabs` | List, open, select or close tabs in the **UABC** tab group (the only tabs AI can see). |
| `browser_navigate` | Load a URL, or go back, forward or reload. |
| `browser_get_state` | The page as compact `[ref] role "name" value=… states` lines; optionally its visible text. |
| `browser_screenshot` | JPEG/PNG of the tab. Numbered badges (Set-of-Marks) match the refs. |
| `browser_click` | Click by ref, CSS selector or x/y with trusted mouse events. Refuses with `OBSCURED` if something covers the target. |
| `browser_type` | Type any Unicode into inputs, textareas and editable areas. Refuses password, OTP and card fields. |
| `browser_press_key` | Keys and chords: `Enter`, `Escape`, `Shift+Tab`, `Control+A` … |
| `browser_scroll` | Scroll the page or a scrollable element. |
| `browser_select_option` | Choose options in a native `<select>`. |
| `browser_wait_for` | Wait for text to appear or disappear (survives navigations). |

Errors come back as tool results with a code and a recovery hint, for example
`STALE_REF: … Call browser_get_state to get fresh refs`, so models can correct
themselves.

## Safety model in one minute

- **Workspace.** AI only sees tabs in the "UABC" tab group. Drag a tab in to
  share it, out to revoke.
- **Per-site approval.** The first visit to a website opens a prompt naming
  the AI client (*UABC assistant (model)*, *claude-code*, *claude-ai (remote)* …):
  *Deny*, *Allow this time* (only that client) or *Always allow*. AI cannot reach
  the prompt. Redirects and back/forward are gated on where they land.
- **No credentials.** Password, one-time-code and card fields are hidden from
  AI and cannot be typed into.
- **Kill switch.** The toolbar *Stop* button, **Alt+Shift+K**, or *Cancel* on
  Chrome's "started debugging" bar pauses every client, local or remote.
- **Your keys stay yours.** API keys live in extension storage that web pages
  and content scripts cannot read, and go only to the provider they belong to.
- **Transparency.** Badge, coloured tab group, connected clients, every step in
  the assistant's chat, and a local activity log. Everything taken from a page
  reaches the model fenced as untrusted content.
- **Locked-down browsers.** Managed browsers that block the debugger can switch
  to *Basic input mode*.

## How is this different?

As of October 2026 there are good alternatives: Claude in Chrome (Claude only),
Google's chrome-devtools-mcp (debugging-oriented), Microsoft's Playwright
extension, and community projects such as `mcp-chrome`. UABC's focus:

- **vendor-neutral**: any model with your own key, any MCP client, cloud apps;
- **no listening port** on your computer; the relay is optional and self-hostable;
- **per-site consent and credential rules enforced inside the extension**, for
  every kind of client alike;
- **first-class non-Latin text input**;
- a **degraded mode for managed browsers**, and enterprise controls on the roadmap.

## Repository layout

```
host/                Rust: the uabc binary (native host, MCP server, relay, installer)
extension/src/
  background/        service worker: gate, commands, native + relay bridges
  content/           page snapshots and actions
  assistant/         built-in assistant: provider adapters, agent loop, settings
  shared/            tool catalog, tool runner and formatter shared with the MCP server
  ui/                popup, settings, side panel, approval prompt
e2e/                 end-to-end tests: real Chromium, real binaries, MCP SDK, fake model APIs
docs/                architecture, protocol, ADRs, guides
```

## Development

```sh
npm run watch              # rebuild the extension on change (reload it in chrome://extensions)
cargo build                # debug binary; run `uabc install --dev` again if the path changed
npm run typecheck
npm run test:unit          # TypeScript unit tests (vitest)
cargo test                 # Rust unit + integration tests
npm run test:e2e           # needs: npm run build:ext && cargo build
```

Host logs are in `~/.uabc/logs/host.log` (`%LOCALAPPDATA%\uabc\logs` on
Windows); set `UABC_LOG=debug` for more. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [Architecture](docs/architecture.md) · [Wire protocol](docs/protocol.md)
- Guides: [built-in assistant](docs/assistant.md) · [running a relay](docs/relay.md)
- Decisions:
  - [ADR-0001 Rust host](docs/adr/0001-native-host-in-rust.md)
  - [ADR-0002 Content scripts + CDP](docs/adr/0002-perceive-with-content-scripts-act-with-cdp.md)
  - [ADR-0003 No-TCP IPC security](docs/adr/0003-local-ipc-security.md)
  - [ADR-0004 Workspace & site grants](docs/adr/0004-agent-workspace-and-site-grants.md)
  - [ADR-0005 Three front-ends, one gate](docs/adr/0005-assistant-and-remote-access.md)
- [Security & threat model](SECURITY.md) · [Privacy](PRIVACY.md) · [Roadmap](ROADMAP.md) · [Chrome Web Store guide](docs/chrome-web-store.md) · [Contributing](CONTRIBUTING.md)

## License

[Apache-2.0](LICENSE). The name and logo are not covered by the license; see
[TRADEMARKS.md](TRADEMARKS.md). Built by the R&D division of
[eJobs IT](https://ejobsit.com), Bangladesh.
