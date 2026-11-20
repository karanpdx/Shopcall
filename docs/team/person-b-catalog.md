# Person B — Authentication, canonical catalog, and API

## Ownership

Own `src/server/**`, `src/app/api/**`, `migrations/**`, and `tests/catalog/`, `tests/auth/`, `tests/api/`. Coordinate `src/contracts/**`, `tests/contracts.test.ts`, and `docs/api-contract.md`. Do not edit call UI or provider adapter internals.

## Build in this order

1. Fixed authenticated demo owner. Configure credentials server-side; no public admin edit links. Secure session cookie, login rate limits, origin/CSRF defenses, ownership checks on every write and draft image read.
2. Select durable DB/storage suitable for deployment. SQLite is available locally, not an assumed safe hosted database. Add migrations for business, products, images, calls, drafts, proposals, approvals, audit events, jobs, and notification state.
3. Implement draft create/update and validated original-image upload. Enforce file size, MIME/decode, dimensions, and owner/draft association. Store original permanently; no SVG/script uploads.
4. Implement public catalog allowlist: active products only, approved public images/contact, integer minor-unit prices, derived sold-out status. No owner identifiers/tokens/drafts in response. Fresh responses with explicit CORS for generated storefront.
5. Preview changes using stable IDs; resolve ambiguous references without arbitrary selection. Apply only owner UI approval, transactionally, with expiry, expected revision, idempotency, quantity bounds, and audit events.
6. Implement publication approval and immutable input snapshot. Queue durable job; expose status. Provide `PublicationRepository` to C; wire C's OAuth, session, publication, and email adapters into routes.

## Handoffs

- Match `docs/api-contract.md`; update it with exact implemented schemas as routes land.
- Give A actual login/session route and stable business/call/draft IDs early.
- Give C `PublicationRepository` implementation, persistent job access, and stable public catalog/image URLs before Replit creation.
- Keep catalog revision separate from storefront revision. Design rebuild must never overwrite product state.

## Acceptance

- Wrong owner/expired session cannot mutate or read private drafts.
- Public reads exclude draft/archived products and private owner data.
- Agent can propose but cannot apply/publish by supplying `confirmed: true`.
- Duplicate idempotency key does not double-apply; stale revision requires new preview/confirmation.
- Sold one versus sold out has distinct semantics; negative inventory is rejected.
- Concurrent mutation batch either fully commits or changes nothing.
- Public catalog updates without rebuilding storefront.
