# The built-in assistant

A chat in Chrome's side panel that uses this browser for you, with your own
API key. Open it with **Alt+Shift+U**, *Open the assistant* in the toolbar
popup, or the button in UABC's settings.

## Providers and models

| Provider | Key from | Models |
|---|---|---|
| OpenAI | platform.openai.com → API keys | Loaded from `/v1/models` (chat models only). |
| Anthropic (Claude) | Claude Console → API keys | Loaded from `/v1/models`; Claude Opus 5.5 is pre-selected. |
| Google Gemini | Google AI Studio → API key | Loaded from the Gemini API (`generateContent` models). |
| OpenRouter | openrouter.ai → Keys | Every model that supports tool calling. |
| OpenAI-compatible | depends | Ollama, LM Studio, vLLM, DeepSeek, Groq, Mistral, xAI, Together … Models are loaded from `<address>/models`, or entered by hand. |

The model needs **tool calling** (function calling). Small local models work
for simple tasks; bigger ones are better at long, multi-step work.

**Ollama**: add the endpoint `http://localhost:11434/v1` (no key). If Ollama
answers 403, allow extension origins: start it with
`OLLAMA_ORIGINS=chrome-extension://*`.

**A model server on another machine** (a GPU box on your network) needs
`https://`, or an SSH tunnel to make it local:
`ssh -N -L 11434:localhost:11434 gpu-box`, then use `http://localhost:11434/v1`.
Plain `http://` is accepted only for this computer: on another network (café
Wi-Fi) the same LAN address could be someone else's machine, which would then
receive your conversation and page content.

## How a turn runs

1. You send a message. The assistant calls the model with your conversation,
   UABC's instructions and the eleven browser tools.
2. For each tool the model calls, the assistant runs it in the browser and adds
   a line to the chat (*Opened…*, *Read the page*, *Typed "…"*). Click a line to
   see exactly what the model received.
3. This repeats until the model answers in text, you press **Stop**, or the step
   limit (default 40, in settings) is reached; then say "continue".

The token line under the chat shows input (and cached) and output tokens of the
last reply.

## What goes where

- **Your API key** is stored in this browser profile, in extension storage that
  web pages and content scripts cannot read, and is sent only to its provider.
- **Page content the assistant reads** (element lists, page text, screenshots)
  and your messages go to the provider you selected, under that provider's
  terms. Turn off *Send screenshots to the model* for text-only models or if you
  prefer not to send images.
- Conversations live in the side panel only; closing it ends the conversation.

## Same rules as every AI client

The assistant is an AI session like Claude Code or a remote app: it only sees
the "UABC" tab group, needs your approval for every new site (you can answer in
the panel or in the prompt window), never touches password or payment fields,
and stops with **Alt+Shift+K**. Its actions are in the activity log as
*UABC assistant (model)*.
