# Privacy policy

*Last updated: 2026-10-27 · applies to the UABC browser extension and the `uabc` program*

UABC runs on your computer. **It has no accounts, no analytics and no
telemetry, and the developers never receive your data.** Two optional features
send data off your computer, and only to services you choose: the built-in
assistant talks to the AI provider whose API key you entered, and remote access
uses the relay you entered.

## What UABC handles, and where it goes

| Data | When | Where it goes |
|---|---|---|
| Content of tabs you shared with AI agents: page structure, visible text, form values (never password, one-time-code or payment fields), screenshots | When an AI client you connected asks for it | From the extension to the `uabc` program on the **same computer**, then to the AI client you configured (for example Claude Code or Cursor). That client may send it to its model provider under **its own** privacy policy. |
| **Built-in assistant**: your messages, and what the assistant reads in shared tabs (page structure, text, form values except protected fields, screenshots if enabled) | When you chat with the assistant | Directly from your browser to the AI provider you selected (OpenAI, Anthropic, Google, OpenRouter, or the endpoint you added), under **that provider's** terms and privacy policy. Nothing passes through UABC servers. |
| **API keys** you enter for the assistant | When you save them | Stored in your browser's extension storage on your device, unreadable for web pages; sent only to the provider each key belongs to. Remove them in settings. |
| **Remote access** (off by default): a random device id, the hashes of two secrets, your profile label; and, in transit, what the connected cloud AI app reads or sends | While remote access is on | To the relay you entered, which forwards it to the AI app that holds your connector URL (for example Claude or ChatGPT, under their terms). The relay stores only the device id, label and hashes. |
| Actions agents performed (activity log: time, client name, action, target, short text excerpt) | Each action | Stored in your browser's extension storage on your device; viewable and erasable in UABC settings. |
| Settings and approved websites | When you change them | Stored in your browser's extension storage on your device. |
| Diagnostic log of the `uabc` program (`~/.uabc/logs/host.log`) | While it runs | Your device only. It contains connection events, not page content at the default log level. |

## What UABC never does

- Read or export cookies, saved passwords, browsing history or browser storage.
- Read tabs you have not shared (tabs outside the "UABC" tab group).
- Send data to the UABC developers, or to any third party you did not choose.
- Sell data, use it for advertising, or use it for any purpose other than
  operating the tabs you shared on behalf of the AI client you chose.

## Your controls

- Share or unshare a tab by moving it in or out of the "UABC" tab group.
- Approve or deny each website, and review or remove approvals in settings.
- Stop every agent with the toolbar button, **Alt+Shift+K**, or *Cancel* on
  Chrome's debugging bar.
- Remove API keys, turn remote access off, or get a new connector URL (which
  revokes the old one) in settings.
- Clear the activity log in settings; uninstalling the extension removes all
  of its stored data. `uabc uninstall` removes the browser registration.

## Contact

Questions or concerns: open an issue in this repository. For security
problems, see [SECURITY.md](SECURITY.md).
