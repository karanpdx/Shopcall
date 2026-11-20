# Shared API handoff — v0

Only `GET /api/health` is implemented in scaffold. Everything below is a proposed implementation contract for the three lanes. B coordinates changes before consumers depend on them.

## Conventions

- JSON properties use camelCase. Types/schemas in `src/contracts` are authoritative for implemented shared entities.
- Responses use `ApiResult<T>` (`{ ok: true, data }` or `{ ok: false, error: { code, message } }`). Health is an operational exception.
- Private endpoints require authenticated demo-owner session. Mutation requests validate same origin/CSRF and strict schemas. Authorization derives from session, never caller-supplied owner ID.
- UUIDs for entities, UTC ISO timestamps, integer minor-unit money, ISO currency, nonnegative quantities or explicitly untracked null.
- Agent client tools may call private data routes using browser's same-origin session. Actual apply/publish requests come from owner approval UI, not arbitrary tool assertions.

## Planned routes

| Endpoint | Responsibility | Expected data |
|---|---|---|
| `POST /api/auth/login` | B | Demo-owner credentials → secure session cookie |
| `POST /api/auth/logout` | B | Revoke session |
| `GET /api/session` | B | Authenticated business, current call/drafts, catalog revision |
| `POST /api/calls` | B | Create/update mode → stable call ID |
| `POST /api/calls/:id/end` | B | End call, preserve drafts |
| `POST /api/voice/session` | B route, C adapter | Call ID → short-lived ElevenLabs session credential |
| `PATCH /api/business` | B | Owner business brief fields → persisted brief |
| `POST /api/drafts` | B | Call ID, optional title, idempotency key → draft ID |
| `PATCH /api/drafts/:id` | B | Spoken/UI field patch → persisted draft |
| `POST /api/drafts/:id/images` | B | Multipart original image + capturedAt → capture/draft IDs and thumbnail |
| `POST /api/catalog/resolve` | B | Phrase → matches; multiple matches require clarification |
| `POST /api/catalog/proposals` | B | `ProposedChanges` → proposal ID, immutable before/after summary, expiry |
| `POST /api/catalog/proposals/:id/confirm` | B | Owner approval nonce + idempotency key → atomic apply or conflict |
| `POST /api/publication/proposals` | B | Exact approved business/product snapshot → publication summary/approval nonce |
| `POST /api/publication/proposals/:id/confirm` | B | Explicit owner approval + idempotency key → queued `BuildJob` |
| `GET /api/jobs/:id` | B | Owner-authorized `BuildJob`, notification state |
| `POST /api/replit/connect` | B route, C adapter | Owner-bound OAuth authorization URL |
| `GET /api/replit/callback` | B route, C adapter | Validate state, exchange code, store tokens; redirect owner status page |
| `GET /api/public/stores/:id/catalog` | B | `PublicCatalog` allowlist; CORS enabled; fresh on reload |

B/A must finalize nonce retrieval/transport together before confirmation UI ships. A cannot manufacture a nonce; B must bind it to exact proposal, owner, expiry and revision. C's voice agent has no confirmation secret.

## Publication adapter

`PublicationRepository` in `src/contracts/integrations.ts` is the minimum C↔B seam. Extend with durable claim/lease/retry methods together once worker implementation is chosen. Do not claim current interface already provides crash-safe execution.

## Generated storefront contract

Public storefront fetches the catalog endpoint over HTTPS at runtime. `business.id` establishes identity; `revision` establishes current catalog state. `products` contains only approved active listings and publicly usable images. Derive sold out from `inventoryTracked && quantityOnHand === 0`. Contact-to-buy only. No private management credentials or mutation endpoints in generated code.
