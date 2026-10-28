# Contributing

Thanks for helping make AI agents safer to use in real browsers.

## Setup

```sh
npm ci
npm run build:ext && cargo build
./target/debug/uabc install --dev     # registers the debug binary for Chrome, Chromium, Edge, Brave
```

Load `extension/dist` as an unpacked extension (`chrome://extensions`,
Developer mode). The manifest's dev `key` keeps the id stable
(`opidijgpffpkhmnenmcdmjbhkgkdceec`), which is what `--dev` trusts.

## Before opening a pull request

```sh
npm run typecheck && npm run test:unit
cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test
npm run test:e2e
```

CI runs the same commands on Linux, macOS and Windows (e2e on Linux).

## Ground rules

- **Policy lives in the extension.** The host is a router. Never move a
  decision about what an agent may do into `uabc` or the AI client.
- **Gate first, then lock.** Command handlers call `pageAccess` /
  `ensureSiteAccess` *before* `withTabLock`. Never wait for the user while
  holding a tab lock.
- **Security behaviour needs a negative e2e test** (e.g. "refuses X").
- **Page content is untrusted everywhere.** In extension pages, render it with
  `textContent` only. In MCP output, pass it through `format.rs` so it stays
  fenced.
- **stdout is sacred** in host and MCP modes: log with `tracing` (stderr or
  file) only.
- **Protocol changes** update `docs/protocol.md`, both implementations, and
  bump `PROTOCOL` if they break compatibility.
- Keep dependencies few and boring. Pin npm packages exactly.
- **Architecture decisions** go into `docs/adr/` (one short ADR per decision:
  context, decision, consequences, alternatives).

## Commit messages

Imperative mood and a short subject (≤ 72 characters), with the body
explaining *why*. Reference issues as `owner/repo#123`.

## Sign your work (DCO)

Every commit in a pull request needs a `Signed-off-by` line. Add it with
`git commit -s`. By signing off you certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org): you
wrote the change, or otherwise have the right to submit it under this project's
license (Apache-2.0). Use your real name; a sign-off is a person's statement,
so a tool cannot sign off for you.

## AI-assisted contributions

AI tools are welcome here; UABC exists to make them more useful. You are still
the author:

- Understand, run and be able to explain every line you submit.
- Say in the pull request description when an AI tool wrote a substantial part
  of the change.
- No bulk or automated pull requests (mass typo fixes, generated refactors).
  They cost reviewers time and are closed without review.

## Reporting security issues

Never in a public issue. See [SECURITY.md](SECURITY.md).
