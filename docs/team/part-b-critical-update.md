# Critical update for B: C's backend orchestration seams

Confirmed November 20, 2026. Codex owns C's server-side provider adapters, product build orchestration and worker scripts. B retains `src/server`, all API routes, canonical catalog, owner auth and persistent approvals. No overlapping route implementations are planned.

## Product harness decision

The harness runs inside the product. After owner approval, ordered specialist tasks build **one** Replit app: design → frontend → catalog integration → QA → publication/verification. User accepted ordered execution. No undocumented parallel-task APIs or separate app per specialist.

## Immediate backend dependencies

1. Provide authenticated owner/business/call context. A model-supplied owner ID or `confirmed: true` is insufficient.
2. Persist an immutable approved publication snapshot: business ID/name, public catalog URL, catalog revision, approved design brief, approval owner and timestamp. C rechecks approval before remote mutations.
3. Supply an authorization adapter that resolves that approval to C's approved merchant brief. Enforce owner match, expiry/revocation rules and exact snapshot identity.
4. Public catalog and photo URLs must be durable HTTPS URLs reachable from deployed Replit app and anonymous browsers. Catalog updates must remain dynamic. Never provide localhost to generated storefront.
5. Queue one active structural build per business and persist job/run identity. Distinguish catalog revision from design/storefront revision.

## Adapter seams under implementation

- Voice: B route validates session/call ownership; C issues short-lived ElevenLabs signed session URL. Agent tool requests pass through the authenticated browser bridge. Actual apply/publish is owner UI only.
- Replit OAuth: B routes bind start/callback to authenticated owner. C uses MCP OAuth discovery/PKCE and encrypted token storage. Codex-side Replit authentication does not authenticate the deployed backend.
- Product orchestration: C exports a task plan and durable, step-based execution service. B supplies approval authorization and production run store. Local file adapter is for persistent local demo volumes; ephemeral serverless storage is insufficient.
- Replit calls with unknown outcomes must block for reconciliation, not blindly create duplicate apps or repeat mutations.
- Publication output schemas and build-readiness signals must be learned from actual connected account. Unknown/prose-only success reports remain blocked.

## Coordination

Keep shared v0 contracts stable while C lands provider modules. Map detailed run states to explicit owner-safe status DTOs; don't overload `ready` to mean submitted. C will publish exact exports and required env names in final handoff. No secrets in docs, logs or browser payloads.

Recommended parallel priority: auth + drafts/catalog + public read endpoint first; then wire voice/session and OAuth/provider routes from C's handoff. Treat live deployment and credential verification as separate evidence gates.
# Current integration checkpoint — November 20, 2026

The integrated worker has automatically created, published and independently verified the original merchant storefront. B's job is completed/completed with the verified public URL. C now consumes the actual v1 catalog envelope, validates the approved public slug, normalizes metadata, and compares current prices/stock/images before publication is exposed.

User explicitly requested a second fixed demo login for an empty catalog. Optional `DEMO_SECOND_OWNER_EMAIL/PASSWORD/BUSINESS_NAME` now provisions a separate owner/business through the existing login flow; authorization isolation tests prove it cannot read the first account's products. This adds no public signup. C's nonproduction local Replit alias recognizes only configured demo identities. Original account/data remain intact.

New product drafts/photo processing continue independently of existing builds. Generated text/image choices require owner selection before freezing the combined batch. Calls now distinguish publication-review handles, catalog-batch IDs and build-job IDs; known preview-handle confusion is corrected without approving or publishing. See `live-call-fixes.md` and `product-media-handoff.md` for exact behavior and validation boundaries.
