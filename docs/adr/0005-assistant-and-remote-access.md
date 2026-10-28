# ADR-0005: Three front-ends, one gate: a built-in assistant and a relay, not a chat-page bridge

- Status: accepted (2026-10-27)

## Context

UABC began as an MCP server for local AI tools ([ADR-0001](0001-native-host-in-rust.md)
to [ADR-0004](0004-agent-workspace-and-site-grants.md)). Users also want to:

1. chat with any model directly in the extension, with their own API key
   (OpenAI, Anthropic, Gemini, OpenRouter, local models), without another app;
2. use the browser from chat apps in the cloud (Claude.ai, ChatGPT, Gemini,
   Google AI Studio).

For (2) there are two technical routes:

- **A chat-page bridge.** A content script on chatgpt.com or claude.ai watches
  the conversation for tool-call text, runs it and types the results back into
  the chat. This needs no cooperation from the vendor, but it automates the
  vendors' consumer web apps. OpenAI's Terms of Use forbid "automatically or
  programmatically extract[ing] data or Output"; Anthropic's consumer terms
  restrict automated access to Claude.ai. It also breaks with every UI change
  and puts tool results where page scripts can tamper with them.
- **Official connectors.** Claude (custom connectors) and ChatGPT (developer
  mode) accept a remote MCP server URL. A remote server cannot reach a browser
  behind NAT, so something public has to sit in between.

Model providers' HTTP APIs differ (Chat Completions, Anthropic Messages, Gemini
generateContent), and some sign their reasoning: Anthropic thinking blocks and
Gemini 3 thought signatures must be sent back unchanged in later requests.

## Decision

1. **Three front-ends, one gate.** The built-in assistant, local MCP clients
   and remote MCP clients are all *AI sessions* in the service worker. Every
   command goes through the same `dispatch()` and the same checks: tab group,
   per-site approval naming the client, sensitive fields, kill switch, audit
   log. No front-end gets a shortcut.
2. **Built-in assistant in the side panel.** The agent loop runs in the side
   panel page, and model calls are made from there; the service worker only
   executes browser commands over a port that accepts UABC's own pages.
   Closing the panel ends the session and its "allow this time" grants.
   - **Same tools, same words.** `shared/tools.ts`, `shared/runner.ts` and
     `shared/format.ts` port the MCP tool layer (`host/src/mcp.rs`,
     `format.rs`) to TypeScript. Unit tests compare tool names, descriptions
     and the safety rules with the Rust source, so the two cannot drift apart.
   - **Three small adapters instead of three SDKs.** One for Chat Completions
     (OpenAI, OpenRouter, Ollama, LM Studio, vLLM, DeepSeek, Groq …), one for
     the Anthropic Messages API, one for Gemini `generateContent`, written
     against `fetch`. Vendor SDKs would triple the bundle, add Node-specific
     shims to a Web Store package, and still need a common layer.
   - **Append-only history, provider content replayed verbatim.** A turn from
     provider X is sent back to X byte for byte (thinking blocks, thought
     signatures, tool-call ids) and rebuilt from neutral text and calls only
     for another provider. Earlier turns are never edited, which also keeps
     prompt caches warm (Anthropic requests use top-level `cache_control`).
   - **Keys.** Stored in `chrome.storage.local`, which the service worker
     restricts to trusted extension contexts, so content scripts in web pages
     cannot read them. Each key is sent only to its own provider. Built-in
     providers have fixed addresses; custom endpoints must use `https://`
     (plain `http://` only for this computer, never the LAN). Requests
     carry no cookies, and keys are masked out of error messages.
3. **Remote access through an optional relay** (`uabc relay`, same binary).
   - The extension opens an outbound WebSocket to a relay the user chooses and
     speaks hop C of [the protocol](../protocol.md) over it. Cloud apps use MCP
     Streamable HTTP at `/mcp/<device id>/<connector secret>`.
   - **Capability URLs**, because both Claude custom connectors and ChatGPT
     developer-mode connectors accept "no authentication" servers but not static
     bearer tokens. The secret has 256 bits, the relay stores only SHA-256
     hashes of it and of the device secret, and *New URL* in the extension
     revokes the old one at once.
   - The relay is a **trusted party**: TLS ends there, so it sees what the AI
     app reads. It is off by default, self-hostable, and can run on the user's
     own computer behind a tunnel. A hostile relay can do no more than a
     hostile AI client: the extension still asks the user for every new site.
4. **No chat-page bridge** in the product. If it is ever built, it will be a
   separate, opt-in experimental extension with the terms clearly stated.

## Consequences

- One security review covers all front-ends: there is a single gate.
- Which cloud apps can attach the relay depends on the vendors (October 2026):
  Claude custom connectors; ChatGPT developer mode, where full write actions
  (click, type) are documented for Business, Enterprise and Edu and Plus/Pro
  may get read-only tools; Gemini Enterprise custom MCP servers (set up by an
  admin). Consumer Gemini app support is unverified, and Google AI Studio has
  no connector feature, so Gemini models are used through the built-in
  assistant (AI Studio API key) or MCP clients such as Gemini CLI.
- Model output is shown as text (a small Markdown subset built from DOM nodes);
  it never becomes HTML.
- Non-streaming requests keep the adapters simple and robust; answers appear
  when complete. Streaming is on the roadmap.
- Remote sessions inherit "Always allow" grants, like any client. Users who
  want remote apps confined further use the "only approved sites" mode.
- Capability URLs can leak through proxy logs and screenshots; the guide says
  how to avoid that, and OAuth 2.1 for the relay is on the roadmap.
