# Roadmap

Planning assumptions: 2–3 engineers, starting November 2026. Every milestone
ends with a demo and a written retro. Dates move; exit criteria do not.

Positioning that drives priorities: several products already let agents use a
real browser session. These include Claude in Chrome (Claude only), Google's
chrome-devtools-mcp with `--autoConnect`, and the Playwright extension.
Vendor-specific browsers (Comet, Gemini in Chrome) cover it too. UABC wins by
being **vendor-neutral, local-first and the safest one to give your real
profile to**, with enterprise controls the others lack. Security work is
therefore product work, not overhead.

## M0: Walking skeleton ✅ (this repository)

- [x] Rust `uabc` binary: native host, MCP server (rmcp 3.8, MCP 2024-11-05 …
      2026-07-28), installer, status, raw `call`.
- [x] No-TCP IPC: Unix socket with peer-UID check, Windows named pipe with DACL.
- [x] MV3 extension:
  - [x] snapshot with refs;
  - [x] trusted CDP input (Bangla via `Input.insertText`);
  - [x] Set-of-Marks screenshots;
  - [x] OBSCURED and STALE_REF protection;
  - [x] tab-group workspace;
  - [x] site prompts;
  - [x] sensitive-field rules;
  - [x] kill switch;
  - [x] audit log;
  - [x] basic input mode.
- [x] 11 MCP tools: status, tabs, navigate, get_state, screenshot, click, type,
      press_key, scroll, select_option, wait_for.
- [x] Tests:
  - [x] 23 Rust unit tests;
  - [x] 5 integration tests (the real binary as host and as MCP server);
  - [x] 14 TypeScript unit tests;
  - [x] 28 end-to-end tests with real Chromium and the official MCP TypeScript
        SDK client.
- [x] Independent security review in two rounds: 7 findings (1 high), then 9
      residual issues found while verifying the fixes. All are fixed, with
      regression tests.

## M0.5: Built-in assistant and remote access ✅ (this repository)

- [x] **Built-in assistant** in Chrome's side panel (Alt+Shift+U), with the
      user's own API key:
  - [x] providers: OpenAI, Anthropic, Google Gemini (AI Studio key),
        OpenRouter, and any OpenAI-compatible endpoint (Ollama, LM Studio,
        DeepSeek, Groq …), with model catalogs and a model picker;
  - [x] the eleven browser tools through a TypeScript port of the MCP tool
        layer, kept identical by parity tests;
  - [x] append-only history that replays each provider's own content
        (thinking blocks, thought signatures), prompt caching, refusal and
        fallback handling;
  - [x] keys readable only by UABC's own pages, sent only to their provider.
- [x] **Remote access** for Claude custom connectors, ChatGPT developer mode
      and other remote MCP clients: `uabc relay` (self-hostable), outbound
      WebSocket from the extension, secret connector URLs with rotation, hashes
      only on the relay.
- [x] `uabc config antigravity`.
- [x] Tests: assistant and relay end to end with fake OpenAI, Anthropic and
      Gemini servers and the MCP SDK's Streamable HTTP client. 159 tests in
      total: 32 Rust unit, 5 Rust integration, 74 TypeScript unit, 48 end to end.
- [x] Third independent security review (assistant and relay): 3 medium and
      2 low findings, all fixed with tests.

## M1: Developer preview (Nov – mid Dec 2026)

Goal: developers can install it in 5 minutes on any OS and use it daily.

- **Coverage gaps**
  - Cross-origin iframes: per-frame content scripts plus CDP child sessions
    (`sessionId`, Chrome 125+).
  - JavaScript dialogs (`alert`, `confirm`, `beforeunload`): report and handle
    via `Page.javascriptDialogOpening`, since they currently block a tab.
  - `browser_hover`, drag and drop, `browser_upload_file`. Upload needs an
    explicit user approval per file.
- **Navigation pre-blocking:** `declarativeNetRequest` rules scoped to shared
  tabs, so a redirect or clicked link to an unapproved site is held *before*
  its first request (today it is gated right after the page commits).
- **Windows hardening:** client-side verification of the pipe server's SID;
  Windows and macOS e2e in CI with branded Chrome via `chrome://extensions`
  load-unpacked automation or Chrome for Testing.
- **Packaging:** `cargo-dist` installers (shell, PowerShell, MSI, Homebrew) that
  run `uabc install`; signed binaries.
- **Distribution:**
  - an MCP Registry entry (`server.json`);
  - an **MCPB bundle** for one-click Claude Desktop install;
  - a documented WSL setup (`uabc.exe mcp` via interop).
- **Assistant:** streaming answers; conversations that survive closing the
  panel (`chrome.storage.session`); cost estimates per conversation; image
  downscaling for small-context models.
- **Relay:** OAuth 2.1 for connectors (both Claude and ChatGPT support it), named
  connectors that can be revoked one by one, a signature challenge instead of
  sending the device secret, a trusted-proxy option for per-client limits, and
  container images.
- **Docs:** a docs site, a 3-minute demo video, recipes (Gmail triage, form
  filling, admin dashboards).
- **Exit criteria:**
  - e2e green on Linux, macOS and Windows;
  - install to first successful tool call in under 5 minutes, tested with 5
    people outside the team;
  - 10 external developers using it weekly.

## M2: Public beta and Chrome Web Store (mid Dec 2026 – Jan 2027)

Goal: a non-developer can install it from the Chrome Web Store safely.

- **Store submission:**
  - single-purpose statement;
  - permission justifications;
  - privacy policy;
  - screenshots and video;
  - reviewer test instructions ([docs/chrome-web-store.md](docs/chrome-web-store.md)).

  Then Edge Add-ons.
- **Onboarding:**
  - the extension detects a missing bridge and shows OS-specific download plus
    `uabc install`;
  - the installer opens the extension page when done.
- **First-use client approval:** a new AI client name must be approved once in
  the extension.
- **Release integrity:**
  - Authenticode (Azure Trusted Signing);
  - Apple Developer ID and notarization;
  - SLSA provenance;
  - published checksums.
- **i18n:** full English and Bangla UI (store listing in both).
- **Exit criteria:**
  - store approval;
  - 1,000 weekly active installs;
  - zero open high-severity security issues.

## M3: Security and enterprise (Feb – Mar 2027)

Goal: safe enough for companies to allow, and the reason they pick UABC.

- **Irreversible-action confirmation:** send, post, pay, delete or submit to a
  new origin needs a user click, decided by heuristics plus page semantics,
  with an override per site.
- **Data-flow guard:** text read on origin A and typed into origin B asks first.
- **Enterprise policy** through a `storage.managed` schema:
  - mode;
  - allow and deny lists;
  - disabled tools;
  - input mode;
  - audit export.

  Force-installed deployments also hide the debugger bar (a Chrome behaviour
  for policy-installed extensions), so the UI must compensate.
- **Chrome 155+ managed-browser debugger restrictions:** automatic fallback to
  basic mode with a clear notice.
- **Audit export:** JSONL, a SIEM recipe, retention settings.
- **External security review / penetration test.** Apply to the **GitHub
  Secure Open Source Fund** with this milestone as the plan.
- **Exit criteria:**
  - audit finished with no unresolved high findings;
  - 3 design-partner companies piloting.

## M4: Ecosystem and performance (Q2 2027)

- **Remote agents, next steps:** pairing codes instead of copied URLs, end-to-end
  encryption between the extension and trusted clients so a relay only sees
  ciphertext, and an audited hosted relay.
- **WebMCP:** surface tools that pages declare via `navigator.modelContext`
  (Chrome origin trial M149–M156), behind the same consent model.
- **Token efficiency:** incremental snapshots (diffs since the last state), an
  optional CDP accessibility-tree mode, text summarisation of long pages.
- **Benchmarks:** publish task success rate, latency and token cost on
  WebArena-style tasks against Playwright MCP and chrome-devtools-mcp.
- **Record and replay:** turn a successful session into a reusable,
  parameterised workflow.
- **Firefox:** feasibility study (WebExtensions has no `chrome.debugger`).

## Non-goals

- CAPTCHA solving, bot-detection evasion, fingerprint spoofing.
- Reading or exporting cookies, saved passwords or browser storage.
- Hidden or headless control of a user's real profile.
- A mandatory cloud service. Everything works locally; the relay is optional
  and self-hostable.
- Driving vendors' consumer chat websites from a content script (a "chat-page
  bridge"); see [ADR-0005](docs/adr/0005-assistant-and-remote-access.md).
