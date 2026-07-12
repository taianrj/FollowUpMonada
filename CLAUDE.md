@AGENTS.md

# Claude Code instructions

- `AGENTS.md` is the canonical project guide imported above. Follow it completely and do not create competing project conventions.
- Do not run `/init` in a way that overwrites or replaces the curated instruction files.
- For broad or risky changes, inspect the repository and present a short implementation plan before editing.
- On every frontend task, explicitly apply the responsive-design review from `AGENTS.md`; responsiveness may not be deferred merely because the requested change is local or narrowly scoped.
- On every task, explicitly apply the security review from `AGENTS.md`; security may not be deferred merely because the requested change is visual, local, or narrowly scoped.
- Before the final response, enforce the canonical completion gate: rerun `npm test` after the last file change and do not declare completion unless it passes.
- If instruction loading is uncertain, use `/memory` to confirm that this `CLAUDE.md` and the imported `AGENTS.md` are active.
