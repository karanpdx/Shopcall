# Shopcall API contract — v1 (Lane B)

Status legend: **implemented + tested locally** means route handlers exist and run against a real SQLite DB and real filesystem storage in `npm test` and a `next start` smoke test. Nothing here is deployed or provider-verified.

Authoritative types: [`src/contracts/api.ts`](../src/contracts/api.ts) (Zod + TS). `src/contracts/catalog.ts` is the earlier v0 proposal (`title`/`priceMinor`/`quantityOnHand`) and is **not** what these routes return; it stays for now so nothing breaks. Plan: remove it after A and C confirm they've moved to `api.ts`.

## Conventions

- JSON, camelCase. Money is integer **USD cents** (`priceCents`), inventory is a nonnegative integer (`inventoryCount`). `soldOut` is derived (`inventoryCount === 0`) and never stored.
- IDs are UUID v4 strings generated server-side. Timestamps are UTC ISO-8601 strings.
- Every response is `ApiResult<T>`: `{ "ok": true, "data": T }` or `{ "ok": false, "error": { "code", "message" } }`. Exceptions: `GET /api/assets/:id` returns image bytes on success, and `GET /api/health` keeps its own shape.
- Private routes need the `shopcall_session` cookie (HttpOnly, SameSite=Lax, Secure in production, 12h). Business identity always comes from the session. No route accepts an owner or business ID from the caller.
- State-changing requests that send an `Origin` header must be same-origin (request origin, forwarded host, or `APP_BASE_URL`). Otherwise the response is `403 FORBIDDEN`. Browsers always send `Origin` on cross-site POSTs.
- Unknown fields are rejected (`.strict()` schemas). A body like `confirmed: true` is invalid input. It never counts as approval.
- Private responses are `Cache-Control: no-store`.

### Error codes

| HTTP | code | When |
|---|---|---|
| 400 | `INVALID_INPUT` | Schema violation or bad JSON. The message lists `path: problem` pairs |
| 401 | `UNAUTHORIZED` | No/expired session, or wrong login |
| 403 | `FORBIDDEN` | Cross-origin mutation |
| 404 | `NOT_FOUND` | Missing **or belongs to another business** (existence is not revealed) |
| 409 | `STALE_REVISION` | `expectedRevision` ≠ current product revision |
| 409 | `CONFLICT` | Draft already resolved, stock would go negative, build already active, illegal job transition |
| 413 | `PAYLOAD_TOO_LARGE` | Upload over `UPLOAD_MAX_BYTES` (default 10 MiB) |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Not JPEG/PNG/WebP by content, declared type mismatch, or undecodable |
| 429 | `RATE_LIMITED` | More than 10 login attempts per IP in 15 min |
| 502 | `STORAGE_ERROR` | Object storage write/read failed. Nothing was persisted |
| 503 | `CONFIGURATION_ERROR` | Required env missing/invalid (DB, session secret, storage, `PUBLIC_API_BASE`) |
| 500 | `INTERNAL` | Unexpected. Details only in server log |

## Auth & business

### `POST /api/auth/login` — public
Request `{ "email": "owner@clayco.example", "password": "…" }`. Credentials are compared with `DEMO_OWNER_EMAIL` / `DEMO_OWNER_PASSWORD`. The first login creates the owner and business (`DEMO_BUSINESS_NAME`; the slug comes from the name and never changes after that). The response sets the cookie and returns `Session`:
```json
{ "ok": true, "data": {
  "owner": { "id": "7c1e…", "email": "owner@clayco.example" },
  "business": { "id": "e918…", "slug": "clay-co", "name": "Clay & Co" },
  "expiresAt": "2026-11-21T11:00:00.000Z" } }
```
Errors: 400, 401, 403, 429, 503.

### `POST /api/auth/logout` — session
Deletes the session server-side and clears the cookie. `{ "signedOut": true }`.

### `GET /api/session` — session
Returns `Session` (same shape as login). 401 when signed out.

### `GET /api/business` — session
Returns `Business`:
```json
{ "id": "e918…", "ownerId": "7c1e…", "name": "Clay & Co", "slug": "clay-co",
  "description": null, "heroTitle": "Made by hand", "heroSubtitle": null, "primaryColor": "#2F4F3A",
  "contactEmail": "hello@clayco.example",
  "publicCatalogUrl": "https://api.shopcall.example/api/public/clay-co/catalog",
  "publishedUrl": null, "catalogRevision": 3, "createdAt": "…", "updatedAt": "…" }
```
`publicCatalogUrl` is `null` when `PUBLIC_API_BASE` isn't configured. `publishedUrl` is set only once a build job's publication is verified (see Builds).

## Products (read-only; all writes go through drafts)

- `GET /api/products` → `Product[]` for the session's business (published and unpublished).
- `GET /api/products/:id` → `Product`, or 404 (also when it belongs to another business).

```json
{ "id": "ac83…", "businessId": "e918…", "name": "Beaded bracelet", "description": "Hand-strung glass beads",
  "category": "Jewelry", "priceCents": 2500, "inventoryCount": 10, "soldOut": false,
  "imageAssetId": "8381…", "imageUrl": "https://api.shopcall.example/api/assets/8381…",
  "isPublished": true, "isFeatured": false, "revision": 1, "createdAt": "…", "updatedAt": "…" }
```
`revision` starts at 1 and goes up by exactly 1 on every approved mutation. Send it back as `expectedRevision`.

## Image uploads

### `POST /api/uploads` — session, `multipart/form-data`, field `file`
- The type is checked from the file's **bytes** (JPEG, PNG, WebP only) and must match the declared type if one is given. The file must also decode as an image (via sharp). SVG, GIF and anything else gets 415.
- Size limit: `UPLOAD_MAX_BYTES` (default 10 MiB) → 413.
- The original is written to durable storage **first**, and metadata is saved only after that write succeeds. If storage fails you get 502 and nothing is recorded. If no storage is configured you get 503.
- 201 → `Asset`:
```json
{ "id": "8381…", "businessId": "e918…", "mimeType": "image/jpeg", "sizeBytes": 183422,
  "width": 1080, "height": 1440, "url": "https://api.shopcall.example/api/assets/8381…", "createdAt": "…" }
```
```sh
curl -b cookies -H "Origin: $APP" -F "file=@bracelet.jpg;type=image/jpeg" $APP/api/uploads
```
Attach the image to a product by passing `imageAssetId` in a `create_product` draft. Storage keys are never returned.

### `GET /api/assets/:id`
Streams the original. **Anonymous** access works only when a published product uses the asset (`Cache-Control: public, max-age=3600`). Otherwise only the owning merchant's session can read it (`private, no-store`). Anyone else gets 404.

## Drafts — propose → owner approves → applied atomically

### `POST /api/drafts` — session
The body is a `ProductChange` (discriminated on `type`):

| type | fields |
|---|---|
| `create_product` | `product: { name, description?, category?, priceCents, inventoryCount, imageAssetId? }` |
| `update_price` | `productId, priceCents, expectedRevision` |
| `update_stock` | `productId, inventoryCount, expectedRevision` (sets absolute stock: "sold out" → 0, "six left" → 6) |
| `adjust_stock` | `productId, delta (nonzero int), expectedRevision` (relative: "sold three" → -3, "six more" → +6) |
| `update_product` | `productId, patch: { name?, description?, category?, isFeatured?, isPublished? }` (non-empty), `expectedRevision` |
| `update_storefront` | `patch: { name?, description?, heroTitle?, heroSubtitle?, primaryColor ("#RRGGBB")?, contactEmail? }` (non-empty) |

Checks at creation: product ownership (404), `expectedRevision` is current (409 `STALE_REVISION`), stock can't go negative (409), the image asset belongs to this business (404). 201 → `Draft`:
```json
{ "id": "d0a1…", "businessId": "e918…", "operation": "update_price", "targetId": "ac83…",
  "previousValues": { "priceCents": 2500 },
  "proposedValues": { "type": "update_price", "productId": "ac83…", "priceCents": 3000, "expectedRevision": 1 },
  "expectedRevision": 1, "status": "pending", "createdAt": "…", "resolvedAt": null }
```
`proposedValues` stores the exact validated change. Approval applies exactly that and nothing else. `previousValues` is a snapshot for "$25 → $30"-style review UI.

### `GET /api/drafts/:id` — session → `Draft`

### `POST /api/drafts/:id/approve` — session, **owner UI only**
In one SQLite `BEGIN IMMEDIATE` transaction: load the draft for this business → require `pending` → re-validate → check product ownership and `expectedRevision` → apply → `revision + 1` → `business.catalogRevision + 1` → mark `approved` (conditional on still `pending`). Any failure rolls back everything.

200 → `DraftApprovalResponse`: `{ draft, product: Product | null, business: Business | null }`. For `create_product`, `draft.targetId` becomes the new product ID. New products are published (`isPublished: true`).

- A second approval of the same draft (sequential or concurrent) returns **409 CONFLICT** `"Draft is already approved."` and applies nothing. It's safe to retry: after a 409, re-read the draft.
- Stale product → **409 STALE_REVISION**. The draft stays `pending` and the product is unchanged. Re-read the product, create a new draft, and confirm again.

### `POST /api/drafts/:id/reject` — session
Marks the draft `rejected` and never touches products. 409 if it's already resolved.

**Lane A:** only the explicit owner Approve button may call `/approve`. Do not expose approve to ElevenLabs client tools.

## Public catalog — anonymous, read-only

### `GET /api/public/:slug/catalog`
URL format: `${PUBLIC_API_BASE}/api/public/${slug}/catalog`, e.g. `https://api.shopcall.example/api/public/clay-co/catalog`. The URL is stable for the life of the business. Price/stock changes show up on the next fetch with no rebuild needed.

- No cookies are read and no auth is needed. `Access-Control-Allow-Origin: *` with no credentials, so any generated storefront origin (Replit preview or published) can fetch it. That's safe because the payload is an explicit public allowlist. `OPTIONS` → 204.
- `Cache-Control: no-store` (the PRD's choice for immediate demo updates).
- Includes only published products. Excludes owner/business IDs, owner email, drafts, jobs, storage keys and unpublished products. `contactEmail` is whatever the owner approved via `update_storefront`.
- 404 for an unknown slug. 503 if `PUBLIC_API_BASE` is unset or invalid, because image URLs must be absolute.

```json
{ "ok": true, "data": {
  "business": { "slug": "clay-co", "name": "Clay & Co", "description": "Small-batch ceramics from Oakland",
    "heroTitle": "Made by hand", "heroSubtitle": null, "primaryColor": "#2F4F3A",
    "contactEmail": "hello@clayco.example", "currencyCode": "USD" },
  "catalogRevision": 3,
  "products": [{ "id": "ac83…", "name": "Beaded bracelet", "description": null, "category": "Jewelry",
    "priceCents": 3000, "inventoryCount": 7, "soldOut": false, "isFeatured": false,
    "imageUrl": "https://api.shopcall.example/api/assets/8381…", "revision": 3, "updatedAt": "…" }],
  "generatedAt": "…" } }
```
Order: featured first, then oldest first. Storefront rules: format `priceCents / 100` as USD, show "Sold out" when `soldOut`, contact-to-buy via `contactEmail`, never hardcode products.

`PUBLIC_API_BASE` must be `https` and not loopback when `NODE_ENV=production`. The helper `publicCatalogUrl(slug)` in `src/server/config.ts` enforces this and is the only place the URL gets built.

## Build jobs

### `POST /api/builds` — session
Body `{ "designBrief"?: string }` (or empty). This freezes a `BuildSpec` (business name and slug, `publicCatalogUrl`, `catalogRevision`, design brief, approving owner, timestamp) and persists a job with `buildStatus: "queued"`, `publicationStatus: "pending"`. 202 → `BuildJob`. Only one active build per business (queued, running, or completed-but-unpublished) → 409. 503 if `PUBLIC_API_BASE` is missing.

**202 means the request is recorded. It does not mean anything has been built or published.** Nothing runs until Lane C's worker claims the job.

### `GET /api/builds/:id` — session → `BuildJob` (404 for other businesses)
```json
{ "id": "af9d…", "businessId": "e918…", "provider": "replit", "providerJobId": "repl-123",
  "buildStatus": "completed", "publicationStatus": "pending", "publicUrl": null,
  "errorMessage": null, "createdAt": "…", "updatedAt": "…" }
```

### State model (enforced in `updateBuildJob`, DB `CHECK` on `public_url`)
```
buildStatus:        queued → running → completed | failed     (forward only; terminal is final)
publicationStatus:  pending → completed | failed              (only after buildStatus = completed)
publicUrl:          null until publicationStatus = completed; required then; https in production
```
UI copy: queued = "Request received", running = "Building", completed+pending = "Publishing", completed+completed = "Live" (show `publicUrl`), failed (either) = show `errorMessage`. When publication completes, the backend also sets `business.publishedUrl`.

## Lane C integration seam (no route files needed)

```ts
import { repository, publicationRepository } from "@/server/repository";
const repo = repository();               // implements ShopCallRepository from src/contracts/api.ts
const next = await repo.claimNextBuildJob();   // { job, spec } | null — atomically queued → running
await repo.updateBuildJob(job.id, { providerJobId: "…" });
await repo.updateBuildJob(job.id, { buildStatus: "completed" });               // only on an observed readiness signal
await repo.updateBuildJob(job.id, { publicationStatus: "completed", publicUrl }); // only after anonymous verification
await repo.updateBuildJob(job.id, { buildStatus: "failed", errorMessage: "safe text" });
```
The v0 `PublicationRepository` is also implemented (`publicationRepository`, with `approvalId` = job ID). It maps `phase` onto the two status fields. `src/server` never imports `src/integrations`, so there's no import cycle.

Not yet implemented (v0 plan, needs C's exports first): `/api/voice/session`, `/api/replit/connect`, `/api/replit/callback`, calls, catalog resolve, retry, lease/heartbeat for crashed workers.

## Configuration (names only)

`DATABASE_URL` (SQLite path, `file:` prefix optional), `SESSION_SECRET` (≥32 chars), `DEMO_OWNER_EMAIL`, **`DEMO_OWNER_PASSWORD`** (new, ≥12 chars), **`DEMO_BUSINESS_NAME`** (new, optional), `PUBLIC_API_BASE`, `APP_BASE_URL` (optional, extra allowed origin), **`UPLOAD_MAX_BYTES`** (new, optional), and storage. For storage, either **`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`** (new; any S3-compatible service, path-style) or **`ASSET_STORAGE_DIR`** (new; local dev or a mounted persistent volume only).
