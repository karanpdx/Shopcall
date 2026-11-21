# ElevenLabs integration handoff

## Implemented

- `src/integrations/elevenlabs/config.ts`: dedicated merchant agent prompt, authenticated sessions, no voice recording, seven-day transcript retention, bounded call duration, nine client tools matching the shared tool names.
- `tools.ts`: provider tool definitions plus strict runtime Zod argument validation. Price/stock are owner statements; unknown identity is clarified. No apply/publish/approval-claim tool exists. `show_confirmation` only opens owner review UI.
- `service.ts`: server-side owner-call authorization seam, remote private-agent verification, single-use signed WebSocket credential issuance, safe errors, persistent/crash-aware provisioning.
- `scripts/setup-agent.ts`: now provisions/reuses the dedicated private agent rather than only listing account agents. This is a deliberate change from scaffold behavior. Saves nonsecret agent identity in ignored `.shopcall/elevenlabs-agent.json`; does not modify `.env.local`.

## A — browser integration

Register the exact nine `shopcallClientTools` names with the ElevenLabs React provider or `useConversationClientTool`. Import `parseClientToolArgs` from `tools.ts` to validate arguments. This module is browser-safe; never import `client.ts` or `service.ts` into client components.

- `record_product_details` has a flat patch: `{ productDraftId, title?, description?, priceMinor?, currencyCode?, quantityOnHand?, inventoryTracked? }`.
- `upsert_business_brief`: `{ name?, description?, style?, contactEmail? }`.
- `create_product_draft`: `{ proposedTitle? }`.
- `capture_product_photo`: `{ productDraftId }`, bound at capture start.
- `get_catalog_summary`: `{}`; call current authenticated business endpoint.
- `resolve_product_reference`: `{ phrase }`; multiple matches require owner clarification.
- `preview_catalog_changes`: `{ changes }`; backend injects call/business identity, revision and idempotency key, never take identity from model.
- `show_confirmation`: `{ kind: "publish" | "catalog_change", proposalId }`; opens existing owner review panel only.
- `get_build_status`: `{ buildJobId }`.

Tools return actual authenticated backend results. The browser is untrusted: tool output is not proof of authorization, confirmation, payment or publication. The backend remains authority. Reconnect reloads canonical catalog; original call/draft IDs must survive provider disconnection.

Session endpoint returns `{ signedUrl, connectionType: "websocket", callId }`. Feed into SDK `startSession({ signedUrl, connectionType: "websocket" })`. Treat signed URL as a secret: never console-log, persist, put into a shareable page URL, or send to analytics. Call `get_catalog_summary` on session start and send relevant existing catalog to conversation context as data. Camera stream must remain independent of voice audio.

New publication proposal creation is still an explicit owner Review action in B's API/UI contract; agent cannot fabricate proposal IDs or publish directly. Add a typed proposal-preparation tool only through B's shared-contract coordination if desired.

## B — backend integration

After verifying session/CSRF/rate limits, call:

```ts
const session = await issueVoiceSession(
  { ownerUserId: sessionOwner.id, businessId, callId },
  { assertOwnerCall: async context => {
    // Query canonical DB: session owner owns business, call belongs to owner/business,
    // call is active, session is current. Throw on any mismatch.
  } },
);
```

All IDs currently require UUIDs. Return `Cache-Control: no-store`. Do not accept `ownerUserId` from request JSON. This seam is intentionally not a substitute for B's actual auth implementation. Bind proposals/approval nonce to exact owner, revisions and snapshot. No claimed tool permission can bypass it.

By default agent ID comes from `ELEVENLABS_AGENT_ID` or ignored local state. Deployed backend must explicitly configure `ELEVENLABS_AGENT_ID` and `ELEVENLABS_API_KEY` server-side, or persist its `.shopcall` directory on durable private disk. Never depend on local ignored files arriving through Git.

## Provisioning and recovery

```sh
npm run agent:setup
# If an interrupted create has an unknown outcome, inspect ElevenLabs dashboard first.
# Adopt only the verified dedicated authenticated Shopcall agent:
npm run agent:setup -- --adopt <agent-id>
```

Provisioning records intent before create and disables SDK create retries. On network timeout/unknown outcome, no second create is attempted automatically. A definite HTTP 400/401/403/404/422 rejection is recorded as rejected, allowing corrected retry. Process lock prevents simultaneous local provisioning. After a crash, reconcile remote outcome before manually removing stale lock; there is no automatic stale-lock reset. Multiple hosts need a shared provisioning repository/lock rather than independent local state.

## Verified versus pending

On November 20, 2026:

- Eight mock/contract tests cover private config, exact tool set, strict inputs, owner-check ordering, single-use issuance, redaction, ID reuse, unknown-create recovery, and definite rejection retry.
- Actual provider agent creation succeeded and returned private managed agent `agent_1301m7xjjdahen2rbkffbz7c7dyk`; remote read-back verified authentication, recording disabled and exact tools.
- Provisioning rerun reused the same ID; no second agent requested.
- Actual signed credential issuance succeeded without opening a WebSocket or starting conversation.
- English configuration initially rejected `eleven_flash_v2_5`; provider required turbo/flash v2. Config uses `eleven_flash_v2` after that real check.
- No browser conversation, microphone, camera capture, end-to-end tool execution, TTS test, or production deployment has been performed. These remain live rehearsal gates.

Dashboard: https://elevenlabs.io/app/agents/agents/agent_1301m7xjjdahen2rbkffbz7c7dyk . Agent requires authentication; there is no public talk link.

Official docs consulted: [Create agent](https://elevenlabs.io/docs/api-reference/agents/create), [signed URL](https://elevenlabs.io/docs/api-reference/conversations/get-signed-url), [client-tool trust model](https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools).
