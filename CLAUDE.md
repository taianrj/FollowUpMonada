@AGENTS.md

# Claude Code instructions

- `AGENTS.md` is the canonical project guide imported above. Follow it completely and do not create competing project conventions.
- Do not run `/init` in a way that overwrites or replaces the curated instruction files.
- For broad or risky changes, inspect the repository and present a short implementation plan before editing.
- Before the final response, enforce the canonical completion gate: rerun `npm test` after the last file change and do not declare completion unless it passes.
- If instruction loading is uncertain, use `/memory` to confirm that this `CLAUDE.md` and the imported `AGENTS.md` are active.
