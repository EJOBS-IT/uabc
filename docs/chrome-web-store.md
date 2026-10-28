# Chrome Web Store submission guide

The extension requests sensitive permissions (`debugger`, `nativeMessaging`,
`<all_urls>`). Expect an in-depth review. Reviewers approve what they can
understand quickly, so submit everything below together. The built-in
assistant makes the extension testable without the companion program: give
reviewers an API key with a small spending limit (see below).

## Build

```sh
npm run build:ext:store      # → extension/uabc-extension-<version>.zip, without "key", minified, no source maps
```

The development manifest carries a public `key` so unpacked builds keep the
id `opidijgpffpkhmnenmcdmjbhkgkdceec` (the native host trusts it with
`uabc install --dev`). The store assigns its own id on first upload. Then:

1. copy the store id into `STORE_EXTENSION_ID` in `host/src/install.rs`, so
   `uabc install` (without `--dev`) trusts exactly the store build;
2. release a new `uabc` binary.

## Listing

- **Name:** "UABC – Universal AI Browser Controller". Do not put third-party
  trademarks (Claude, ChatGPT, Gemini …) in the name. The description may say
  "works with MCP clients such as …".
- **Single purpose:** *"Let an AI assistant chosen by the user (the built-in
  side-panel assistant with the user's own API key, an AI tool on the user's
  computer, or an AI app connected by the user) operate browser tabs the user
  explicitly shares, with the user's approval for each website."*
- **Category:** Developer Tools (later: Productivity).
- **Languages:** English, Bangla (`_locales/en`, `_locales/bn`).

## Permission justifications (paste into the dashboard)

| Permission | Justification |
|---|---|
| `nativeMessaging` | Connects to the UABC companion program (`uabc`) installed by the user on the same computer. That program relays requests from the AI tools the user chose. |
| `debugger` | Delivers trusted mouse and keyboard input (Chrome DevTools Protocol `Input.*`) and screenshots to tabs the user shared with the assistant. Synthetic page events are ignored by many sites and cannot type non-Latin text such as Bangla. Chrome shows its "started debugging" bar while this is active, and pressing Cancel stops the assistant. |
| `tabs` | Lists and opens tabs in the user's "UABC" tab group, and reads their URL and title to ask the user for per-site approval. |
| `tabGroups` | The assistant may only act inside the "UABC" tab group. Users share or unshare a tab by moving it in or out of the group. |
| `scripting` | Injects UABC's own bundled page script, on demand and only into shared tabs, to read the page structure and locate elements. |
| `storage` | Stores the user's settings, approved sites, the local activity log, and the API keys the user enters for the built-in assistant (restricted to the extension's own pages; content scripts cannot read it). |
| `alarms` | Retries the connection to the companion program (and to the user's relay, if remote access is on) once a minute. |
| `sidePanel` | Shows the built-in assistant's chat next to the page the user is working on. |
| Host permission `<all_urls>` | The assistant may work on any site the user approves at run time; access is additionally gated per site by UABC's own approval prompt, and users can narrow it in Chrome's "Site access" setting. It also lets the built-in assistant call the AI provider the user configured (for example api.openai.com, or a local Ollama server). |

## Remote code

**None.** All JavaScript is bundled in the package. The extension never evaluates
strings received from the native host, the relay or a model provider; model
output is displayed as text and tool calls are data checked against a fixed
list of eleven tools. The Debugger API is used only for
`Input.*`, `Page.captureScreenshot`, `Page.getLayoutMetrics` and
`Emulation.setFocusEmulationEnabled`. The MV3 policy explicitly lists the
Debugger API as an allowed documented API. If a future version adds script
evaluation, it must go through `chrome.userScripts` (user toggle required) or
be disclosed and justified here first.

## Privacy practices (data disclosure form)

- **Data handled:** website content (the shared tabs' visible structure and
  text, screenshots), user activity (actions the assistant performs), and
  authentication information (the API keys the user enters for the built-in
  assistant).
- **Use:** only to provide the single purpose. Depending on what the user set
  up, data goes to the companion program on the same device and from there to
  the AI tool the user configured; to the AI provider the user selected for the
  built-in assistant, together with the user's key for that provider; or, if the
  user turned on remote access, through the relay the user entered to the AI
  app the user connected.
- **Not sold, not used for advertising or creditworthiness,** and not
  transferred to the developer. UABC operates no servers that receive user data.
- **Privacy policy URL:** publish [PRIVACY.md](../PRIVACY.md) on the project site
  (or link the file on GitHub).

## Reviewer test instructions

Reviewers cannot install a native program, but they can test the built-in
assistant directly:

1. an OpenRouter or OpenAI API key with a small spending limit, revoked after
   review, with steps: open settings → paste the key → Alt+Shift+U → "Open
   example.com and tell me the page title" → approve the site;
2. a 2–3 minute unlisted video showing:
   - install;
   - the site-approval prompt;
   - the assistant and an MCP client filling a form in Bangla;
   - a password field being refused;
   - Stop / Alt+Shift+K;
3. a statement that MCP clients need the companion program and remote access
   needs a relay, both off unless the user sets them up;
4. a link to this repository and to the release binaries with checksums.

## Before each release

- [ ] Version bumped in `package.json` (copied into the manifest by the build)
      and in `Cargo.toml`.
- [ ] `npm run test:unit && cargo test && npm run test:e2e` green.
- [ ] Store zip built with `--store`; checked that `manifest.json` has no `key`.
- [ ] Changelog and screenshots updated.
