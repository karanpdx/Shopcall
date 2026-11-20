# Integrated call workspace and voice bridge

This additive C integration uses B's actual authenticated repository and SQLite database. It adds working call/draft tables without changing the canonical product model or directly applying any voice-requested change. Parent owns B's atomic catalog-batch proposal/review/confirm/reject endpoints and Replit build integration.

## Routes implemented

All responses use B's `ApiResult<T>`. New private routes use `requireOwner` plus stricter mutation Origin validation: browser Origin must equal configured `APP_BASE_URL` (or request URL origin if unset). `x-forwarded-host` does not expand this allowlist. JSON call/tool bodies have a streamed 64 KiB limit; image bytes use B's validated multipart uploader instead.

| Route | Body | Response |
|---|---|---|
| `POST /api/calls` | `{ mode: "create" | "update", idempotencyKey }` | `{ call, drafts }`; call UUID and stable `publicationReviewId` |
| `GET /api/calls/:id` | — | `{ call, drafts }`; readiness, missing fields and private image URLs included |
| `POST /api/calls/:id/end` | — | Ended call; does not discard staged fields/photos |
| `POST /api/calls/:id/drafts` | `{ idempotencyKey, proposedTitle? }` | Blank/partial working product draft with stable ID |
| `PATCH /api/calls/:id/drafts/:draftId` | Partial `{ title, description, priceMinor, currencyCode, quantityOnHand, inventoryTracked }` | Saved draft and readiness; does not publish |
| `POST /api/calls/:id/drafts/:draftId/images` | Multipart `file` + optional `X-Captured-At` ISO header, **or** JSON `{ imageAssetId, capturedAt }` for an existing B-uploaded owner asset | `{ captureId, productDraftId, thumbnailUrl, draft, ready, missing, saved: true, published: false }` |
| `POST /api/calls/:id/drafts/:draftId/proposal` | — | `{ proposal, applied: false, requiresOwnerReview: true }`; B batch of one full `create_product` change |
| `POST /api/voice/session` | `{ callId }` | Single-use `{ signedUrl, connectionType: "websocket", callId }`, `Cache-Control: no-store` |
| `POST /api/voice/tools` | `{ callId, name, arguments, idempotencyKey }` | Validated tool-specific result; no approval token |

Session owner/business are always derived from cookie, never request body. A call/draft from a different owner or business is inaccessible. Voice sessions/tools require an active call. Owner UI may still inspect, correct and prepare saved drafts after hangup; this does not reopen audio. Image association uses the URL's exact call/draft ID and checks B asset ownership, not whichever UI product became active during an async upload.

The initial B product schema supports USD and tracked inventory. `currencyCode` other than USD and `inventoryTracked: false` are rejected with a clarification message. Missing price or stock stays absent; zero is valid. No inferred/default stock is inserted.

## Person A hookup

1. Authenticate via B's login, create call once with a stable retry idempotency key, retain returned call UUID for reconnect.
2. Request `/api/voice/session` and use the returned signed URL with ElevenLabs SDK. Never log/persist/send credential to analytics. Camera stream stays independent of this audio session.
3. Register the nine tool names from `elevenlabs/tools.ts`. Most can forward typed arguments to `/api/voice/tools` with the current call UUID and one stable request key per invocation/retry.
4. **Capture tool is local**: when `capture_product_photo` is requested, snapshot the current camera image bound to its supplied draft ID and post it to that draft's `/images` endpoint. Camera off means do not capture; offer file upload. Only uploaded endpoint success with `captureId` establishes saved photo. The server-side capture-tool result deliberately says `captured: false, saved: false` and asks the browser to perform capture; it never pretends a server captured the camera.
5. Show product fields and missing-field indicators. Owner clicks Review for complete draft, triggering its `/proposal` endpoint. Then use parent's batch review endpoint to retrieve actual before/after summary and confirmation nonce; explicit owner click calls confirm. Never route an agent-generated `confirmed: true` field to an apply endpoint.
6. `show_confirmation` returns an action to open an existing review panel only. Catalog proposal must belong to the same owner/business/call. Publication kind requires this call's `publicationReviewId` returned by `get_catalog_summary`/call creation; it opens publication review UI and does not enqueue a build. Parent's explicit owner build action queues Replit work.
7. `upsert_business_brief` only stages name/story/style/contact in the working call. Owner review should prepare an `update_storefront` batch using parent's proposal endpoint; style goes into reviewed design brief for Replit. Do not treat staged brief as already canonical/public.

Call start/reconnect should fetch `get_catalog_summary`: current canonical B products include stable IDs and revisions, plus saved workspace fields and `publicationReviewId`. Phrase resolution returns all matching products; ambiguous names produce no selected ID. Price/stock previews become one B atomic batch using original product revisions and current catalog revision. Ordinary approved catalog edits do not trigger a Replit rebuild.

## Person B / parent seams

`callWorkspace()` from `src/integrations/call-workspace/runtime.ts` returns the service wired to `getDb()` and actual `repository()`:

```ts
const owner = requireOwner(req);
const workspace = callWorkspace();
workspace.store.assertActive(owner, input.callId); // tool/proposal creation
workspace.store.getCall(owner, batch.callId);     // owner review after hangup is allowed
```

`CallWorkspaceStore` owns additive `shopcall_calls_v1`, `shopcall_working_drafts_v1`, `shopcall_voice_attempts_v1` tables. No token, audio/video or full transcript is stored there. Rate-limit reservations persist before provider calls; at most five session attempts per owner per minute, including provider failures. Ending a call during credential issuance prevents returning the credential to browser.

Product proposal preparation freezes exact working draft revision/catalog revision before creating B's proposal. Unknown interruption replays the same deterministic key and frozen payload; duplicate products are not created. A definite B validation/revision rejection releases reservation. Pending/approved proposal freezes editing. Reject through owner's batch API first, then PATCH to correct; clearing a rejected link increments working revision so re-proposal uses a fresh key. Original stored image assets remain available.

## Validation and limits

Nine integration tests exercise actual B auth/SQLite/route handlers and filesystem image upload; provider credential issuance is injected/mocked and no actual conversation, TTS or network credential request runs in these tests. Tests cover owner/origin isolation, partial drafts, post-call persistence/corrections, real ID-bound image upload, complete proposals without mutation, multi-match lookup, combined update preview, uploaded asset ownership, rejected-draft revision, unknown-proposal recovery and proposal preparation races.

The workspace uses B's configured SQLite persistence; deployment still requires a durable volume or database migration. No UI was edited in this lane, so A still must connect controls/review panels to these endpoints. No claims of live browser voice, automatic deployment or end-to-end production acceptance are established by these tests.
