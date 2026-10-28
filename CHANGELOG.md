# Changelog

## 0.2.0 (unreleased): built-in assistant and remote access

- **Built-in assistant** (side panel, Alt+Shift+U) that works with the user's
  own API key:
  - OpenAI, Anthropic (Claude), Google Gemini (AI Studio key), OpenRouter, and
    any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, DeepSeek, Groq …);
  - model catalogs loaded from each provider, model picker, step limit,
    optional screenshots;
  - the same eleven tools, arguments, limits and untrusted-content fences as the
    MCP server (TypeScript port with parity tests against the Rust source);
  - append-only history replaying each provider's own content (Anthropic
    thinking blocks, Gemini thought signatures), Anthropic prompt caching and
    server-side refusal fallbacks, retries with `retry-after`, Stop mid-turn;
  - every step shown in the chat; site prompts can be answered in the panel;
    answers in the user's language.
- **API keys** are stored where content scripts cannot read them
  (`chrome.storage.local` restricted to trusted contexts), sent only to their
  own provider, never with cookies, masked in errors and in settings.
- **Remote access** (`uabc relay`): Claude custom connectors, ChatGPT developer
  mode and other remote MCP clients reach the browser through a self-hostable
  relay. The extension connects out over a WebSocket; each browser gets a
  secret, rotatable connector URL; the relay stores only SHA-256 hashes; remote
  apps pass the same gates and prompts, named "… (remote)".
- `uabc config antigravity` prints the Antigravity MCP configuration.
- The badge no longer reports a missing bridge as an error: the assistant works
  without it.
- **Hardening from the third independent review** (assistant and relay):
  - relay limits before authentication (hello size, pending hellos, labels),
    batched device-record writes, a bounded send queue, 30-day device expiry,
    and an optional access code (`--registration-token`);
  - plain `http://` only for this computer (never the LAN), no redirects with
    API keys, preset providers pinned to their address;
  - remote sessions end after 10 idle minutes, each remote app gets its own
    session, client names are cleaned and always marked "(remote)";
  - a new device identity for every relay address;
  - `browser.status` no longer lists other clients.

## 0.1.0 (unreleased): walking skeleton

- **`uabc` binary (Rust):**
  - native messaging host;
  - MCP server via `rmcp` 3.8 (protocol 2024-11-05 … 2026-07-28);
  - `install` / `uninstall` for Chrome, Chromium, Edge and Brave on Windows,
    macOS and Linux;
  - `status`, `config`, `call`.
- **IPC without a network listener:** Unix socket (`0600`, peer-UID check) and
  Windows named pipe (current-user DACL, remote clients rejected).
- **MV3 extension:**
  - snapshots with stable refs and document ids;
  - trusted input through the DevTools protocol (Unicode/Bangla);
  - Set-of-Marks screenshots;
  - `OBSCURED` and `STALE_REF` protection;
  - basic input mode.
- **Safety:**
  - "UABC" tab-group workspace;
  - per-site approval prompts;
  - password, OTP and payment fields protected (including inside cross-origin
    frames);
  - kill switch (popup, Alt+Shift+K, debugger bar);
  - local activity log.
- **Hardening from the independent security review:**
  - per-client approval prompts;
  - Stop aborts in-flight actions;
  - every page-derived string is fenced;
  - history and redirect navigation is gated on the destination;
  - unapproved tabs are redacted;
  - document and origin are re-checked right before input;
  - sensitive fields are also recognised by English and Bangla labels;
  - second round:
    - the site is re-verified before any content-script step;
    - only an explicit Deny parks a tab;
    - queued calls honour Stop;
    - basic-mode capture checks the visible tab;
    - page-quoting errors are flagged and fenced;
    - angle brackets in page text are escaped;
    - an attach race is closed;
    - prompts are withdrawn when the bridge drops;
    - grant changes are serialised.
- **11 MCP tools:** `browser_status`, `browser_tabs`, `browser_navigate`,
  `browser_get_state`, `browser_screenshot`, `browser_click`, `browser_type`,
  `browser_press_key`, `browser_scroll`, `browser_select_option`,
  `browser_wait_for`.
