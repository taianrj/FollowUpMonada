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

## Responsive design requirements

- For every frontend task, preserve the intended desktop experience and explicitly review phone, tablet, laptop, and desktop layouts.
- At minimum, reason about widths around 320px, 375px, 768px, and 1024px. Check wrapping, overflow, touch targets, fixed dimensions, modals, and all relevant UI states; verify visually when the environment permits it.
- Add responsive regression coverage when practical. Responsive behavior is part of the task, not optional follow-up work.

## Security requirements

- For every task, review the security impact and affected trust boundaries, including authentication, authorization, per-user isolation, validation, output encoding, secrets/PII, filesystem and URL construction, HTTP methods, CORS/CSRF, and safe failures as applicable.
- Apply least privilege and fail closed. Client-side checks and hidden UI are never sufficient security controls.
- Do not weaken existing protections, expose server data or secrets, broaden proxy/API access, or introduce unsafe defaults. Stop and report the risk if a request conflicts with security or data isolation.

On Windows PowerShell, use `npm.cmd` or `npx.cmd` if script execution policy blocks the `.ps1` shims.
