# FollowUp Monada workspace rule

Before starting any task, read and follow the complete root `AGENTS.md` and `.agents/CONTEXT.md`. Treat `AGENTS.md` as the canonical source when instructions overlap.

## Mandatory test gate

- Never mark a task complete until `npm test` has been run from the repository root after the last edit and all unit tests pass.
- This applies even to documentation, configuration, migration, and instruction-only changes.
- A narrower test command does not replace the final full suite.
- Add a regression test for every behavior change or bug fix; never delete, skip, weaken, or over-mock a test just to pass.
- If the suite fails, keep working. If it cannot be executed, report a blocker instead of completion.

Also run `npm run build` for Next.js/React/TypeScript changes, `node --check whatsapp-service/server.js` when that server changes, and `git diff --check` before handoff.

Protect credentials and user data, preserve unrelated worktree changes, avoid destructive Git or production operations, and follow the WhatsApp/Baileys identity, status filtering, synchronization, media, batching, and persistence invariants in `AGENTS.md`.
