# Connected A frontend handoff

A's orb/camera/product-sheet design is preserved. This change connects its v0 assumptions to the actual B catalog and C call workspace, without changing provider adapters, API routes or stylesheets.

## Actual connections

- Demo owner signs in through `POST /api/auth/login`. `GET /api/session` plus `GET /api/business` supplies real owner business context. There is no anonymous owner-session creation path.
- `POST /api/calls` includes a stable request key and returns `{call,drafts}`. Working call ID is kept in sessionStorage so refreshing restores persisted drafts. No voice credentials/passwords are stored there.
- `POST /api/voice/session {callId}` supplies the short-lived signed WebSocket URL. Browser awaits the real SDK start promise; failure preserves drafts and offers retry/manual input.
- All nine typed voice tools call `POST /api/voice/tools {callId,name,arguments,idempotencyKey}`. Arguments match C's flat schemas. Owner IDs and confirmation secrets never come from agent arguments.
- Camera starts **off** on every new call. Camera video stream is separate from voice audio. Capture first validates current call/draft ownership through the bridge, then uploads actual multipart `file` to `/api/calls/:id/drafts/:draftId/images` with `X-Captured-At`. Asynchronous responses remain bound to the original draft UUID. Upload fallback works without camera.
- Private owner thumbnails use same-origin `/api/assets/:assetId`, derived from the backend-confirmed capture/asset ID. They do not depend on sending owner cookies to a separate public tunnel. Public storefront images still use the canonical approved public URLs.
- Working draft create/PATCH use C's `/api/calls/:id/drafts` routes. Backend call snapshots restore existing original-image previews. Demo is USD with exact tracked stock; unsupported untracked-stock UI was removed.
- Product review uses C's product-to-batch proposal endpoint, then B's owner-only `/api/catalog/proposals/:id/review` token route. Token remains inside owner UI. Explicit confirmation calls `/confirm` with `confirmationToken` and idempotency key. Voice can open review but cannot apply.
- Returning price/stock edits use the real atomic batch returned by the voice bridge. Ambiguity/error data stays visible and is not converted into success.
- Builds use actual `POST /api/builds {designBrief,expectedCatalogRevision}` and `/api/builds/:id` polling. Adapter translates B's two status fields into A's progress component; candidate URLs remain hidden until both statuses are completed.
- Workflow blocked/reconciliation state renders “needs attention” and stops fake forward progress. Original B build/publication statuses remain present in the UI adapter result; a blocked workflow never exposes a ready URL.

## Non-blocking merchant flow

`End call` always stops audio/camera and records call end. It does not approve or publish. `Finish & review` does that, then opens saved-draft review. Optional story/style questions can be skipped; manual add/edit/photo upload remains available. Starting voice is not required to finish an already saved draft.

Intake products are reviewed sequentially so one approved product's catalog revision does not invalidate simultaneous proposals for the others. Each product/business batch requires its own owner click. `Not yet` rejects the pending batch, allowing correction. Approved working drafts lock their creation fields; later changes use returning-call proposals. The final public-storefront review shows canonical saved products and approved contact information, then an explicit Publish click queues a real build. No fake publication/progress URL is generated locally.

Final business name/contact can be entered in review and approved through an actual update_storefront batch after the voice call ends. Voice-captured business details remain working brief data until that owner approval.

## Validation and limits

21 UI adapter/reducer/status tests cover actual bridge field names, scoped call IDs, flat parameters, upload form/path/timestamp and same-origin private thumbnails, unknown/disabled camera handling, confirmation secret isolation, ID-bound asynchronous capture, blocked workflow status and hidden candidate URLs. TypeScript passes for these modules. Tests use explicit mocked HTTP responses and establish adapters/state logic, not live microphone/camera/provider acceptance.

Parent is performing real local browser checks and the full repository build. No live microphone conversation, real camera capture, successful Replit publication or email delivery is claimed by these UI changes. Email copy is conditional and failure copy does not imply a prior working storefront disappeared.

Known operational gates remain backend configuration, demo-owner credentials, microphone permission on the user's device, private ElevenLabs agent, durable database/storage, authenticated Replit account/tool flow and actual published browser verification. Local status page remains available if email sender is not configured.
