# AGENTS.md

This repository is a fresh redesign of the Rolldown execution-order fuzzer.

Before changing behavior, read the relevant records in `.agents/docs/`. The old repository was deliberately deleted; do not recover old `.mjs` scripts unless a record explains the behavior being restored and the new TypeScript design still wants it.

Use plain English in repo files. Keep implementation TypeScript strongly typed and runnable by Node's native TypeScript support; see [techknowly-stack.md](techknowly-stack.md).

## Project Context Records (PCR)

This project follows **Project Context Records (PCR)** — methodology: https://github.com/hyf0/project-context-records. PCR keeps the project's durable design context — the *why*, the decisions, the architecture — so you inherit it instead of re-deriving or re-litigating what's already settled.

When working here:
- **Where they live.** Records are in `.agents/docs/` — one topic per file, cross-linked with relative Markdown links (`[name](./name.md)`).
- **Read first.** If a record covers the area you're touching, read it before acting.
- **Record as you go.** Proactively write down context worth keeping — and whenever a human asks you to. No required format, no fixed list of what qualifies: if it's true about this project, not visible in the code, and useful beyond the moment, it's worth a record.
- **Keep it fresh.** If your change affects a record, update it in the same change — a stale record is a trap, not an asset.
- **Provenance.** An unstamped line is AI-accumulated: challenge and verify it freely. A `[VOUCHED @handle]` stamp (on a line, or at the top of a file) means a human vouched for it — treat it as settled; reopen or re-verify only on new evidence, a changed constraint, or a human's say-so. Add a stamp only on a human's explicit instruction; reading past a line, or not objecting, is not a stamp.
