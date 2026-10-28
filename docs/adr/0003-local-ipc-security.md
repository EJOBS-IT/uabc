# ADR-0003: No network listener. The operating system decides who may connect.

- Status: accepted (2026-10-27)
- Answers open question 3 of the founding spec ("to stop unauthorized access
  to localhost communication, Windows DPAPI or a one-time handshake token?")

## Context

The founding spec sketched a loopback server on `127.0.0.1:9222`, a custom
port, and asked how to authenticate it: Windows DPAPI or a one-time handshake
token. Looking at the threats first:

- **Any local process, of any user, can connect to a loopback TCP port.**
  Multi-user machines, other users' malware and container side-cars all count.
- **Web pages can reach loopback too.** WebSockets are not subject to CORS
  (cross-site WebSocket hijacking), DNS rebinding works against host-header-
  naive servers, and browser-side Local Network Access checks are a mitigation
  we do not control, not a boundary we can rely on.
- **Port 9222 is the conventional Chrome DevTools port.** It collides with real
  debugging setups and is the first port scanners and malware try.
- **DPAPI is encryption at rest for the current Windows user.** Any process
  running as that user can decrypt the blob, so it does not authenticate a
  caller, and it is Windows-only.
- **A handshake token has to be delivered somewhere.** Same-user processes can
  read it from that file, env var or registry key. It is valuable for pairing
  across a *network*, not for same-machine IPC.
- **Same-user malware is out of scope for any design.** It can already read
  the browser profile, inject into the browser or synthesize OS input.

## Decision

There is **no TCP listener anywhere** in UABC:

| Hop | Mechanism | Who enforces access |
|---|---|---|
| Browser ↔ host | Native messaging over stdio | Chrome launches the host only for extension ids in the manifest's `allowed_origins`; the host also validates the caller origin in `argv[1]`. |
| AI client ↔ host (Unix) | Unix domain socket, `0600`, inside a `0700` directory; every connection's peer UID is checked (`SO_PEERCRED` / `getpeereid`) | The kernel. |
| AI client ↔ host (Windows) | Named pipe with a **protected DACL** granting only the current user's SID and SYSTEM, `PIPE_REJECT_REMOTE_CLIENTS`, `FILE_FLAG_FIRST_PIPE_INSTANCE` | The kernel. |

Therefore **neither DPAPI nor tokens are needed today**: there is no secret to
store and nothing to authenticate that the OS does not already authenticate.

Supporting rules:

- Instance ids from the extension become file and pipe names, so they are
  restricted to `[a-z0-9-]{1,32}` (no path traversal; tested).
- A second host for the same browser profile refuses to start instead of
  hijacking the endpoint (tested).
- The host never writes to stdout except the protocol, never logs page content
  at the default level, and enforces Chrome's 1 MiB host→extension limit
  before writing, so oversized commands cannot tear down the port.
- **There is no tool that reads cookies, storage or saved passwords.** The
  "real session" is used only by acting inside pages. This preserves
  protections such as Chrome's app-bound encryption.

The boundary that really matters is not the socket. It is **prompt injection
through web content**, handled by the policy layer in the extension
([ADR-0004](0004-agent-workspace-and-site-grants.md)).

## When DPAPI-style storage *will* be used

Remote agents (devcontainers, SSH hosts, cloud sandboxes) cannot reach a local
socket. ROADMAP M4 adds an **opt-in** Streamable-HTTP bridge with:

- a pairing code shown in the extension and approved by the user;
- per-client, revocable tokens;
- tokens stored with the OS keychain (DPAPI / macOS Keychain / libsecret, via
  the `keyring` crate);
- TLS or an SSH tunnel; and an Origin and Host allow-list against browser
  attacks.

WSL → Windows Chrome needs none of this: WSL interop can launch the Windows
`uabc.exe mcp` directly over stdio (to be verified and documented in M1).

## Known gaps (tracked in ROADMAP)

- **Windows pipe squatting.** A different local user could create the pipe name
  *before* our host starts; `FILE_FLAG_FIRST_PIPE_INSTANCE` makes our host fail
  loudly, but clients should also verify the server's SID
  (`GetNamedPipeServerProcessId` → token user). Planned for M1.
- **Which AI client is connecting is self-reported.** Any same-user process can
  connect and claim to be "claude-code". That includes an MCP config shipped
  inside a cloned repository. Site approvals still apply to it. M2 adds
  first-use approval of new client names in the extension. Docs recommend
  user-scope MCP configuration.
