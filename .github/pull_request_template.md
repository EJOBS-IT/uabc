## What and why

<!-- What does this change, and why is it needed? Link the issue: Fixes owner/repo#123 -->

## How it was tested

- [ ] `npm run typecheck && npm run test:unit`
- [ ] `cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test`
- [ ] `npm run test:e2e`

## Safety

- [ ] Decisions about what an agent may do stay in the extension, not in `uabc` or the AI client.
- [ ] New or changed security behaviour has a negative e2e test ("refuses X").
- [ ] Page content stays untrusted: `textContent` in extension pages, fenced in tool output.

## Checklist

- [ ] Every commit is signed off (`git commit -s`, see [CONTRIBUTING.md](../CONTRIBUTING.md#sign-your-work-dco)).
- [ ] If an AI tool wrote a substantial part of this change, it is mentioned above.
- [ ] Docs updated where behaviour changed (`docs/protocol.md` for protocol changes).
