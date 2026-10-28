# ADR-0001: The native host and MCP server are one Rust binary

- Status: accepted (2026-10-27)
- Deciders: UABC lead developer, eJobs IT R&D
- Answers open question 1 of the founding spec ("Rust, or a lighter Node/Go binary?")

## Context

UABC needs three local programs:

1. a **native messaging host** the browser launches (`connectNative`), speaking
   length-prefixed JSON over stdio;
2. an **MCP server** each AI client launches (Claude Code, Codex, Cursor,
   Gemini CLI, VS Code, LM Studio, Goose …), speaking MCP over stdio;
3. an **installer / diagnostics tool** that registers the host with each
   browser (JSON manifests on Linux/macOS, `HKCU` registry keys on Windows).

Constraints:

- End users are not necessarily developers. They must not need Node.js, Python
  or a JVM installed, and enterprise IT must be able to deploy one signed file.
- The host runs for the whole browser session; it must be small and boring.
- It parses messages from two sides (browser and AI clients), so memory safety
  matters.
- MCP itself is moving fast. Revision `2026-07-28` removed the `initialize`
  handshake (SEP-2567), but most clients in the wild still speak `2025-11-25`
  or older. We must speak both without hand-maintaining the protocol.
- The team already shipped a Rust + Tauri 2 + MV3 native-messaging product
  (IDS, `ids-host.exe`).

## Decision

One Rust binary, `uabc`, with several roles:

| Invocation | Role |
|---|---|
| `uabc chrome-extension://<id>/` (by the browser) | native messaging host (argv sniffing, because native host manifests cannot pass arguments) |
| `uabc mcp [--target <profile>]` (by the AI client) | MCP server on stdio |
| `uabc install / uninstall / status / config / call` | installer, diagnostics, raw command CLI |

MCP is implemented with the **official Rust SDK, `rmcp` 3.8**. It negotiates
every revision from `2024-11-05` to `2026-07-28` and gives us typed tools and
JSON-schema generation from Rust structs.

## Evidence (measured on this skeleton, Linux x86-64)

| Metric | Value |
|---|---|
| Release binary | 4.1 MB, depends only on libc |
| Host start → ready (spawn to `welcome`) | 3.7 ms |
| Idle memory, host / MCP server | ≈ 5.8 MB RSS each |
| Windows build | type-checks and passes clippy for `x86_64-pc-windows-gnu` (named pipe + DACL + registry code) |
| Interop | the official MCP **TypeScript** SDK drives our Rust server in the e2e suite |

## Alternatives considered

- **Node.js / TypeScript.** Would share types with the extension and lower
  the contribution barrier. But it needs a runtime on every machine, or a
  40–90 MB single-executable bundle per platform. It also adds slower start-up
  and a larger, attacker-reachable dependency tree in a long-lived process.
  Rejected for the host. TypeScript is still used where it belongs: the
  extension and the e2e tests.
- **Go.** Equally good single-binary story, and an official Go MCP SDK exists.
  Rejected only for team fit: nobody on the team ships Go today, while Rust is
  already proven in IDS.
- **Separate binaries per role.** Rejected: more to sign, install and version.
  Roles share 90 % of the code (protocol types, IPC, discovery).

## Consequences

- The wire protocol is shared between Rust and TypeScript by documentation
  ([protocol.md](../protocol.md)) plus tests on both sides, not by generated
  code. If drift becomes a problem, generate TS types from the Rust structs
  (`schemars` → JSON Schema → TS).
- Rust compile times and a smaller contributor pool are accepted costs.
- Release engineering: build a matrix (win/mac/linux × x64/arm64), Authenticode
  signing, macOS notarization. `cargo-dist` is the planned tool (ROADMAP M1).
