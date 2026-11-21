# Collaboration rules

Read `README.md`, `docs/decisions.md`, `docs/api-contract.md`, and your assigned `docs/team/person-*.md` before editing.

- Three contributors work concurrently. Do not revert others' edits or change files outside your assigned ownership without coordination.
- Use separate clones/worktrees and feature branches. Open small PRs against `main`; do not force-push shared branches.
- `src/contracts/**`, package manifests/lockfile, root config, and this file are shared. Person B coordinates contract edits; Person C coordinates dependency/root-config edits. Ask the coordinating teammate before changing these files; then include consumers in the same PR or document migration.
- Do not install dependencies casually in parallel. Person C batches dependency changes; everyone else rebases and runs `npm ci` after those merge.
- Never inspect, print, commit, or send `.env.local` or OAuth credentials. Use provider health checks that report status without values.
- Provider API keys remain server-side. Public catalog is read-only. Owner writes require server-side authentication and explicit owner approval. Model assertions never establish approval.
- Replit must automatically create and publish a real storefront. No template fallback or fabricated URL/status/email evidence.
- Camera-off must preserve audio and prohibit new captures. Bind asynchronous media results to stable draft IDs.
- Do not introduce an ElevenLabs webhook without implementing signature verification. Initial tool bridge may use authenticated same-origin browser requests.
- Run `npm test`, `npm run typecheck`, and `npm run build` for meaningful changes. Add tests for authorization, confirmations, identity association, conflicts, retries, and provider-failure behavior as implemented.
- Clearly distinguish scaffold, implemented, tested locally, provider-verified, and deployed behavior in handoffs.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
