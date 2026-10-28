# Running a relay

AI apps in the cloud — Claude (custom connectors), ChatGPT (developer mode), any
client that accepts a remote MCP server — cannot reach a browser on your
computer. A relay sits in between:

```
AI app ──HTTPS: MCP Streamable HTTP──▶ uabc relay ◀──WebSocket (outbound)── UABC extension
        /mcp/<device id>/<connector secret>      /ws
```

The browser connects *out* to the relay, so nothing on your computer listens
for connections. The relay is part of the `uabc` binary.

## What the relay sees and stores

- **Stores** (`devices.json` in its data directory, mode 0600): for each browser,
  its random device id, the SHA-256 of its device secret and of its current
  connector secret, its profile label, and timestamps. Never the secrets
  themselves, never page content.
- **Sees in transit**: everything the AI app reads or sends, because TLS ends at
  the relay (or at the proxy in front of it). Only use a relay you trust: your
  own, or one run by someone you would trust with that content.
- It cannot bypass the extension. New websites still need your approval in the
  browser, password and payment fields stay blocked, and Stop works.

## Run it

```sh
uabc relay --listen 127.0.0.1:8787        # prints: UABC relay listening on http://127.0.0.1:8787
```

Options: `--data-dir` (default `~/.uabc/relay`), `UABC_LOG=debug` for more log
output. `GET /healthz` returns `{"ok":true,"version":…,"devices_online":…}`.

The relay speaks plain HTTP; put TLS in front of it. Cloud apps require
`https://`, and the extension refuses plain `http://` relays except on this
computer (`localhost`, `127.0.0.1`).

### Option 1: a server with Caddy (automatic HTTPS)

```caddyfile
relay.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

Caddy writes no access log unless you add a `log` directive. Keep it that way,
or filter the request URI out of the log: the connector secret is part of the
path.

Run `uabc relay` as a service (systemd, Docker, …) next to it. WebSockets pass
through `reverse_proxy` without extra settings.

### Option 2: on your own computer, through a tunnel

Run the relay locally and expose it with a tunnel such as
`cloudflared tunnel --url http://127.0.0.1:8787`, Tailscale Funnel or ngrok.
The extension connects to `http://127.0.0.1:8787` directly; the AI app uses the
tunnel's `https://` address. Then the only third party is the tunnel provider.

In this setup enter the **public** address as the relay in UABC's settings, so
the connector URL it shows is the public one; the extension reaches the same
relay through the tunnel.

## Connect a browser and an AI app

1. UABC settings → *Use this browser from Claude, ChatGPT and other AI apps* →
   turn on remote access, enter the relay address (`https://relay.example.com`).
   The status line shows *Connected to the relay*.
2. Copy the **connector URL** (`https://relay.example.com/mcp/<device>/<secret>`).
3. Add it to the AI app (vendor features as of October 2026; check their
   current help pages):
   - **Claude**: add a custom connector and paste the URL.
   - **ChatGPT**: turn on developer mode, then add a connector with this URL and
     no authentication. OpenAI documents full MCP with write actions (UABC's
     click, type, select …) for Business, Enterprise and Edu; on Plus and Pro you
     may only get the read-only tools. ChatGPT asks you before each write action.
   - **Gemini Enterprise**: an admin adds a custom MCP server with this URL and
     no authentication. Custom apps in the consumer Gemini app are not verified.
   - **Other apps**: anything that accepts a remote MCP server (Streamable HTTP).
4. Ask the app to use the browser. The first visit to each site opens a prompt
   in the browser naming the app, for example *claude-ai (remote)*.

## Keep the URL secret

Anyone with the connector URL can ask to use your browser (you still approve
each site). Don't paste it into shared documents or screenshots. *New URL* in
the settings revokes the old one immediately. Turning remote access off
disconnects the browser from the relay.

## A private relay: access code

By default anyone who can reach `/ws` can add a browser (within the limits
below). For a company or family relay, require an access code:

```sh
uabc relay --listen 127.0.0.1:8787 --registration-token 'a-long-random-code'
# or: UABC_RELAY_TOKEN='a-long-random-code' uabc relay …
```

Users enter it under *Access code* next to the relay address. Browsers that are
already registered keep working without it.

## Limits and hardening

- New devices: 10 per client address per hour, 10,000 per relay. Behind a
  reverse proxy all clients share the proxy's address, so the per-address limit
  applies to everyone together; use an access code instead.
- Devices not seen for 30 days are forgotten; they simply register again.
- At most 32 connections may be waiting to say hello; a hello is at most 16 KiB.
- A remote app's session ends after 10 idle minutes, and with it any "allow
  this time" the user gave it. The next call starts a new session.
- A browser that stops reading its commands (more than 256 queued) is
  disconnected.
- WebSocket messages up to 16 MiB (full-page screenshots); a browser that stays
  silent for 75 s is disconnected (the extension pings every 20 s).
- `/ws` accepts only browser extensions (`Origin: chrome-extension://…`), so
  web pages cannot register devices.
- Unknown devices and wrong secrets both get `404`.

Planned: OAuth 2.1 for connectors, per-connector names and revocation, and a
hosted relay with an audited deployment (see [ROADMAP.md](../ROADMAP.md)).
