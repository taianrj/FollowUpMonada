# FollowUp Monada - Project Instructions

These are the canonical repository instructions for coding agents. Follow them for every task in this repository.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Mandatory completion gate

- A repository task is **not complete** until `npm test` has been run from the repository root **after the final file change** and all unit tests pass.
- This gate applies to every task that changes repository files, including documentation, configuration, migrations, and agent-instruction files.
- Never report a task as complete based on tests run before the last edit. Rerun them.
- Never say that work is complete when tests are failing, were skipped, or could not be run. Continue fixing failures; if execution is genuinely impossible, report the task as blocked and state exactly what prevented verification.
- Bug fixes and behavior changes must include or update a regression test that fails without the fix and passes with it.
- Do not delete, skip, weaken, or over-mock tests merely to make the suite pass.

## Required verification commands

Run commands from the repository root unless stated otherwise.

1. Always run the complete unit suite after the final change:

   ```bash
   npm test
   ```

2. For any change that can affect Next.js, React, TypeScript, routing, configuration, or production bundling, also run:

   ```bash
   npm run build
   ```

3. For changes to `whatsapp-service/server.js`, also run:

   ```bash
   node --check whatsapp-service/server.js
   ```

4. Before handoff, always run:

   ```bash
   git diff --check
   ```

5. Run ESLint on changed TypeScript/TSX files when practical. Do not hide or silently repair unrelated legacy lint findings; distinguish pre-existing issues from regressions introduced by the task.

On Windows PowerShell systems that block `npm.ps1`, use `npm.cmd`/`npx.cmd` with the same arguments.

## Repository architecture

- The root application is Next.js 16 App Router, React 19, strict TypeScript, and Supabase.
- `src/app/`: pages, layouts, route handlers, and server-side application code.
- `src/components/`: React UI. Keep Server Components as the default; add `'use client'` only when browser state, effects, or browser APIs are required.
- `src/lib/`: reusable domain, Supabase, and WhatsApp frontend/proxy helpers.
- `whatsapp-service/`: independent Node.js/Express CommonJS service using `baileys@7.0.0-rc13` loaded through dynamic ESM import.
- `whatsapp-service/lib/`: testable WhatsApp domain/state helpers.
- `whatsapp-service/test/`: Node test-runner unit and HTTP tests.
- Root `*.sql` files are Supabase schema/migration artifacts. Treat them as production-sensitive.
- `whatsapp-service/data/`, `.env*`, credentials, auth-state, media queues, and generated build output are local/runtime data and must not be committed.

## General working rules

- Inspect the relevant implementation, tests, `package.json` scripts, and current `git status` before editing.
- Preserve user changes and unrelated dirty-worktree files. Never use destructive Git commands such as `git reset --hard` or discard changes you did not create.
- Make the smallest coherent change that fixes the root cause. Avoid broad rewrites, formatting churn, or dependency upgrades unrelated to the request.
- Keep shared business rules in small testable modules rather than duplicating logic in UI components or HTTP handlers.
- Keep user-facing text in Brazilian Portuguese unless the existing surface intentionally uses another language.
- Use `America/Sao_Paulo` for business dates and validate calendar dates rather than relying on permissive JavaScript parsing.
- Preserve backward compatibility for persisted records and explicitly migrate or safely filter legacy shapes.
- Do not commit, push, deploy, rotate secrets, or mutate production data unless the user explicitly requests that action.

## Next.js and frontend rules

- Before modifying Next.js code, read the relevant installed documentation under `node_modules/next/dist/docs/`; do not rely on remembered APIs from older Next.js versions.
- Respect Server/Client Component boundaries and the async forms of APIs documented by the installed Next.js version.
- Keep secrets and service-role credentials out of Client Components, browser bundles, logs, URLs, and `NEXT_PUBLIC_*` variables.
- The browser must access WhatsApp through the authenticated allowlisted proxy in `src/app/api/whatsapp-service/[...path]/route.ts`; do not expose the upstream service secret or create an open proxy.
- Keep proxy paths and HTTP methods explicitly allowlisted in `src/lib/whatsapp/proxy.ts` and add tests for any new route.
- Prevent overlapping polling requests, use bounded timeouts, and distinguish transient upstream failures from authoritative disconnected states.
- Preserve accessible loading, empty, error, reconnecting, syncing, stalled, and completed UI states.
- Add Vitest coverage for pure parsing, status, proxy, filtering, and state-transition logic.

## Supabase, security, and production data

- Never print, copy into documentation, or commit `.env.local`, JWTs, service-role keys, WhatsApp service secrets, API keys, auth-state, phone numbers, message bodies, or other production PII.
- Service-role credentials are server-only. Preserve RLS and per-user isolation on every table, query, cache, and storage path.
- Sanitize user-derived identifiers before filesystem use and keep all data scoped by the authenticated user ID.
- SQL migrations should be additive, idempotent where practical, documented, and compatible with the current fallback behavior. Do not drop or rewrite production data without explicit authorization and a recovery plan.
- Production investigation is read-only by default, even when access exists. Use the narrowest query, redact outputs, and request explicit authorization before any production write, cleanup, resync, logout, or credential operation.
- Destructive WhatsApp endpoints (`logout`, log clearing, forced recovery) must remain POST-only, authenticated, and explicit.

## WhatsApp/Baileys invariants

- Treat PN (`@s.whatsapp.net`) and LID (`@lid`) as aliases, not interchangeable primary keys. Use `remoteJidAlt`, `participantAlt`, contact `id`/`phoneNumber`/`lid`, history `lidPnMappings`, and the official `lid-mapping.update` event.
- Auth persistence must support the Baileys 7 key types `lid-mapping`, `device-list`, and `tctoken`.
- Use Baileys `BufferJSON` semantics whenever raw/protobuf messages, media keys, Buffers, or Uint8Arrays cross JSON persistence boundaries.
- Do not move Baileys event listeners into persistence or per-message functions. Register each listener once per current socket generation and ignore stale generations.
- Do not infer a direct conversation from a participant until the raw chat JID has been classified.
- `status@broadcast` is a WhatsApp Story/Status, not a conversation. Ignore it at socket ingestion, message processing, and legacy read filtering. Do not accidentally suppress ordinary direct chats, groups, or non-status broadcast lists.
- Preserve `fromMe` exactly. Never infer it from names, phone numbers, bubble position, or owner aliases.
- History is complete only after the official Baileys `messaging-history.status` RECENT signal is explicit, the final corresponding batch has arrived, all local batch work is drained, and no processing error occurred. Never mark history complete from an inactivity timer, connection-open event, bootstrap-only signal, or message count.
- A Baileys `paused` history signal or local processing failure must remain `stalled`/pending, never `completed`.
- Transient socket closes should be `connecting`/reconnecting. Only an authoritative logged-out state or sustained confirmed failure may become disconnected.
- History processing must be deduplicated and batched. Avoid per-chat sequential persistence, per-contact rescans of message files, per-media state writes, or one remote auth request per key file.
- Audio/image queue persistence must retain the raw media message with BufferJSON compatibility. `downloadMediaMessage` reupload context must include a valid bound `updateMediaMessage`; omit the context if it is unavailable.
- Do not permanently discard retryable media failures. Preserve bounded retry/backoff diagnostics and persistent queue state.
- Keep message retention behavior explicit (`MESSAGE_RETENTION_DAYS`, currently two days by default) and do not silently widen full-history ingestion.
- Preserve hybrid persistence: local daily files, relational Supabase rows, and fallback session blobs. Reads must merge/deduplicate without reintroducing filtered status messages or ambiguous routes.

## Test expectations by area

- Frontend/domain/proxy changes: update or add `*.test.ts`/`*.test.tsx` tests and run `npm run test:web` during iteration.
- WhatsApp service changes: update or add `whatsapp-service/test/*.test.js` and run `npm run test:whatsapp-service` during iteration.
- Baileys changes must cover identity routing, fromMe, status filtering, history completion, auth key persistence, BufferJSON/media behavior, and listener placement when relevant.
- HTTP changes must test authentication, method restrictions, validation, and safe failure behavior.
- Performance fixes should include a testable batching/deduplication boundary whenever possible.
- The final gate remains `npm test` from the root, even if narrower suites already passed.

## Definition of done

Before declaring completion, verify all of the following:

- The requested behavior is implemented at the correct layer and the root cause is addressed.
- Regression tests were added or updated and meaningfully exercise the changed behavior.
- `npm test` was rerun after the final edit and passed.
- Required syntax checks/builds also passed for the changed area.
- `git diff --check` passed and the final diff contains no unrelated or sensitive files.
- The handoff reports what changed, what was verified, and any remaining limitation. Do not conceal skipped checks or unverified production behavior.
