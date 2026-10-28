# ADR-0002: Perceive with content scripts, act with the DevTools protocol, keep a basic fallback

- Status: accepted (2026-10-27)
- Answers open question 2 of the founding spec ("only `chrome.debugger`, or
  direct content-script event dispatch?")

## Context

An agent needs two things from a page: to **perceive** it (what is there,
what can be clicked, what does it say) and to **act** on it (click, type, press
keys, pick options, scroll).

Two mechanisms exist inside an extension:

| | Content script (isolated world) | `chrome.debugger` (Chrome DevTools Protocol) |
|---|---|---|
| Events | Synthetic: `isTrusted: false`, no user activation | Real input pipeline: `isTrusted: true`, user activation |
| Unicode text | Synthetic `KeyboardEvent`s cannot produce text; Bangla is impossible | `Input.insertText` commits any Unicode like an IME |
| Rich editors (Gmail compose, Docs, Notion, Slate/ProseMirror) | Often ignore synthetic input | Behave as with a human |
| Popups, clipboard, file pickers, fullscreen | Blocked (need user activation) | Work |
| Reading the DOM | One in-process pass: fast, sees closed shadow roots via `chrome.dom.openOrClosedShadowRoot`; page scripts cannot tamper with the isolated world | Many CDP round trips over native messaging; the AX tree is heavy |
| User-visible cost | None | "UABC started debugging this browser" bar while attached |
| Availability | Always | Can be blocked. Since **Chrome 155** (Oct 2026) `attach()` fails on managed browsers when an admin sets `runtime_blocked_hosts` for the extension or screenshot-blocking (DLP) policies. |
| Web Store review | Normal | `debugger` is a sensitive permission (longer review). The MV3 remote-code policy names the Debugger API as an allowed documented API. |

## Decision

A hybrid. Each mechanism does what it is best at:

1. **Perception → content script**, injected on demand **only into shared
   tabs** (never on every page). It builds the element list with refs, roles,
   names, values and states, redacts sensitive fields, draws Set-of-Marks
   badges for screenshots, and hit-tests.
2. **Action → CDP** (`Input.dispatchMouseEvent`, `Input.insertText`,
   `Input.dispatchKeyEvent`) and **screenshots → CDP** (`Page.captureScreenshot`,
   normalized to CSS pixels so image coordinates equal click coordinates).
3. **Locate before acting.** For every ref-based action the content script
   scrolls the element into view and checks that the element itself is
   topmost at the click point (trying several points). If something else is
   on top it fails with `OBSCURED` and names the blocker ("covered by dialog
   'Cookie consent'"). That prevents misclicks on ads, cookie banners and
   click-jacking overlays, and tells the model how to recover.
4. **Refs are tied to a document.** Each snapshot returns a document id; the
   MCP server sends it with every ref-based action. Refs from a previous page
   fail with `STALE_REF` instead of clicking whatever now has the same number.
5. **Basic input mode** (setting, per browser profile) uses synthetic events
   and `captureVisibleTab` instead of CDP: no banner, less fidelity. It is the
   fallback for managed browsers where Chrome 155+ blocks the debugger. When
   CDP is unavailable the error tells the agent and user how to switch.

The debugger banner becomes a feature: it is an unmistakable indicator that an
AI is acting. Clicking **Cancel** on it pauses all agents (kill switch).

## Evidence (from the e2e suite)

- All clicks reach the page with `isTrusted: true`.
- Bangla (`সত্যজিৎ রায়`), emoji and multi-line text land exactly in
  inputs, textareas and `contenteditable`.
- A button under a cookie overlay is refused with `OBSCURED` naming "Cookie
  consent"; after clicking Accept the same ref works.
- A ref from the previous page is refused with `STALE_REF` after navigation.
- Basic mode completes the same form flow with synthetic events.

## Alternatives considered

- **CDP only** (the Playwright extension relays raw CDP to the server). It is
  the most capable and lets heavy logic live outside the store-reviewed
  extension. But perception becomes chatty and slow over native messaging, the
  banner is always on, and Chrome 155 managed-browser restrictions break the
  product completely. Rejected as the *only* path; we still use CDP for actions.
- **Content script only.** No banner and simplest review. But no trusted
  events, no user activation, and no non-ASCII typing, which is a deal breaker
  for Bangladeshi users and any rich editor. Kept only as the fallback.
- **`chrome.automation` (accessibility API).** ChromeOS-only for extensions.
- **WebDriver BiDi.** Not reachable from an extension.

## Consequences

- Two input paths to maintain; both are covered by e2e tests.
- `debugger` and `<all_urls>` need careful justification for the Chrome Web
  Store (see [chrome-web-store.md](../chrome-web-store.md)).
- Cross-origin iframes (payment widgets, embedded video) are not yet
  inspected; the snapshot says so and suggests a screenshot plus coordinate
  click. Per-frame CDP sessions (`sessionId`, Chrome 125+) are planned for M1.
