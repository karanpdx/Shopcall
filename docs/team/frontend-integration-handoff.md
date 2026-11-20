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
- Returning-call catalog review uses B's owner-only `/api/catalog/proposals/:id/review` token route. Token remains inside owner UI. Explicit confirmation calls `/confirm` with `confirmationToken` and idempotency key. Voice can open review but cannot apply.
- Intake uses `POST /api/calls/:id/review` to combine ready new products and owner business/contact details into one atomic batch. The displayed combined summary contains no approval secret. One explicit **Confirm and publish** click obtains the owner nonce, commits that exact batch, then queues the storefront build using the expected new catalog revision. Incomplete drafts are clearly excluded and retained for later.
- Returning price/stock edits use the real atomic batch returned by the voice bridge. Ambiguity/error data stays visible and is not converted into success.
- Builds use actual `POST /api/builds {designBrief,expectedCatalogRevision}` and `/api/builds/:id` polling. Adapter translates B's two status fields into A's progress component; candidate URLs remain hidden until both statuses are completed.
- Workflow blocked/reconciliation state renders “needs attention” and stops fake forward progress. Original B build/publication statuses remain present in the UI adapter result; a blocked workflow never exposes a ready URL.

## Non-blocking merchant flow

`End call` always stops audio/camera and records call end. It does not approve or publish. `Finish & review` does that, then opens saved-draft review. Optional story/style questions can be skipped; manual add/edit/photo upload remains available. Starting voice is not required to finish an already saved draft.

Intake has **one combined review**, not separate product/business/publication confirmation rounds. `Not yet` rejects the pending combined batch, allowing correction. One consent action covers displayed product/contact publication and queues the real storefront build. Approved working drafts lock their creation fields; later changes use returning-call proposals. No fake publication/progress URL is generated locally. If catalog approval succeeds but the build request fails, UI retains the applied status and retries the build without re-creating products or re-applying catalog changes. An uncertain apply response is reconciled against the persisted batch status first.

Final business name/contact can be entered in review and included in the same combined update_storefront batch after the voice call ends. Voice-captured business details remain working brief data until that owner approval.

## Validation and limits

24 UI adapter/reducer/status/media-permission tests cover actual bridge field names, scoped call IDs, flat parameters, single combined review preparation, upload form/path/timestamp and same-origin private thumbnails, unknown/disabled camera handling, confirmation secret isolation, ID-bound asynchronous capture, blocked workflow status, hidden candidate URLs and audio-only permission probing/temporary-track cleanup. TypeScript passes for these modules. Tests use explicit mocked HTTP responses and establish adapters/state logic, not live microphone/camera/provider acceptance.

## Media-control regression fix

User's video/control bug reproduced because `.ft > *` overrode `.ft-video` to `position: relative`: full-height video entered flex layout and pushed function controls outside the clipped call screen. More-specific layer rules now keep video absolute with no pointer interception, top controls and footer overlays positioned independently, and compact footer controls at short/landscape viewports. Idle microphone icon now starts voice rather than being disabled; explicit text Start voice call remains reachable with camera on.

Four additional opt-in browser regressions use synthetic canvas video and mocked API responses, with Chrome fake-device flags as a second guard against real device use. They check elementFromPoint hit-testing at 390×844, 844×390 and 320×480, actual camera-off track stopping and preview removal, and meaningful denied-microphone guidance before any provider-session request. They were observed red before the fix and green afterward. Run against an already running local app:

```sh
UI_BROWSER_TEST_URL=http://localhost:3000 node --import tsx --test tests/ui/browser-media.test.ts
```

Without this explicit URL, browser tests skip rather than starting an app or requesting devices. Synthetic tests do not establish working user microphone audio or a successful ElevenLabs conversation; those still need user-device acceptance. Microphone preflight runs only after Start is clicked, asks audio only, releases its temporary stream, and reports permission/missing-device/busy errors safely before the real SDK takes ownership.

Parent is performing real local browser checks and the full repository build. No live microphone conversation, real camera capture, successful Replit publication or email delivery is claimed by these UI changes. Email copy is conditional and failure copy does not imply a prior working storefront disappeared.

Known operational gates remain backend configuration, demo-owner credentials, microphone permission on the user's device, private ElevenLabs agent, durable database/storage, authenticated Replit account/tool flow and actual published browser verification. Local status page remains available if email sender is not configured.
