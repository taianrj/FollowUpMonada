# FollowUp Monada - Antigravity project context

`AGENTS.md` at the repository root is the canonical engineering guide for this workspace. Before changing code, schema, configuration, documentation, or tests, read it completely and follow it.

Critical non-negotiable rules:

- A task is not complete until `npm test` is rerun from the repository root after the final file change and every unit test passes.
- If tests fail, continue fixing the implementation. If tests cannot run, report the task as blocked; never label it completed.
- Add regression tests for every bug fix or behavior change. Do not weaken tests to obtain a pass.
- For Next.js/React/TypeScript changes, also run `npm run build`.
- For `whatsapp-service/server.js`, also run `node --check whatsapp-service/server.js`.
- Always run `git diff --check` before handoff.
- Preserve secrets, production PII, RLS, user isolation, the dirty worktree, and all WhatsApp/Baileys invariants documented in `AGENTS.md`.
- Do not commit, push, deploy, or mutate production unless the user explicitly requests it.

On Windows PowerShell, use `npm.cmd` or `npx.cmd` if script execution policy blocks the `.ps1` shims.
