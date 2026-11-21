# Critical update for A: product-side build orchestration

Confirmed November 20, 2026. Codex owns C: backend provider integration and product-side Replit orchestration. B owns catalog/auth/API routes; A owns merchant UI.

## What changed

The requested harness runs **inside Shopcall**, after the merchant approves their brief. It coordinates specialist build tasks for the merchant's Replit storefront. It is not a harness for contributors building Shopcall itself.

MVP uses **ordered specialist tasks in one Replit app**, explicitly accepted by the user. Do not represent these as independently controlled parallel subagents. Roles cover design, frontend, catalog integration, QA, and deployment. Public MCP documents app creation/updates/publication, not task-spawn/merge controls.

## UI implications

- Call agent collects a structured brief and product drafts. The owner reviews public contact info, photos, prices and inventory before approval.
- The build service freezes that approved snapshot. Show actual task/phase state, including blocked/failed and retry/reconciliation states. Do not invent percentage progress.
- A queued request, Replit app ID, completed specialist task, and verified live site are distinct states. Show the public link only after publication and anonymous verification.
- Returning price/stock calls update canonical catalog through B. They do not trigger specialist code rebuilds.
- The voice agent can request confirmation UI, but cannot apply/publish by asserting approval. Owner UI action goes to B's authenticated route.
- ElevenLabs session credentials come from B's route calling C's server adapter. No private API key in browser. Camera and audio lifetimes stay independent.

## Expected seams

Shared v0 types remain under `src/contracts`. C's additional runtime types will live under `src/integrations/orchestrator` and `src/integrations/publication`; B should map backend run state to owner-safe status DTOs. These are under implementation on `feat/integrations`; use the final handoff before wiring exact function names.

Codex will not edit A's UI files or B's route files in this lane. Coordinate contract changes through B.

## Call experience: thorough without trapping the caller

User specifically wants useful information without excessive questions or keeping the merchant on a long call. A owns the interaction and visible escape paths; C owns the conversational prompt/tools. Implement these together:

- Keep **Finish & review** and **End call** visible throughout. Ending preserves drafts; it never silently publishes. Finishing opens a compact review even if some drafts are incomplete. The owner can complete required fields there or resume later.
- Use one broad opening. Harvest all volunteered business/style/product facts. Never ask a question whose answer is already in canonical state or the current draft.
- For an item, invite the merchant to show it and give name, price and available count naturally together. Ask follow-ups only for missing required fields or genuine identity/quantity ambiguity. Reuse established store currency; show it in final review rather than reasking for every item.
- Required for an approved listing: identity/title, exact price/currency, explicit stock quantity or intentionally untracked stock, chosen original photo. Required for publication: business identity, approved public contact and a combined owner approval. Missing values remain visibly incomplete; no default stock of one or inferred prices.
- Story, audience, detailed branding, shipping preferences, variants, pricing advice and image enhancement are optional. Do not march through a questionnaire. Use already volunteered preferences; offer optional enrichment after the starter store is ready or when the owner asks.
- Show progress through actual complete/incomplete product cards. A card should allow correction by touch/typing; the caller should not need several spoken turns to fix a photo label.
- Perform one combined final readback/review. Avoid per-field confirmations followed by the same full confirmation again. Backend click approval stays authoritative. A price/stock ambiguity is clarified before this review, not guessed away.
- Returning multi-product updates get one concise before/after summary and one combined apply confirmation. Camera starts off; audio continues if camera is toggled.
- Once inputs are saved/approved, release the caller to a persistent status screen. Do not keep audio open while Replit builds. Say email will be sent only if notification configuration actually exists, and never claim sent/live before backend evidence.
- A roughly two-minute intake is a demo design target, not a hard cutoff or measured claim. Offer a minimal first version and a visible exit; don't interrupt volunteered useful information to enforce a timer.

Call-policy helper and example scripts are being developed separately within C. Integrate the final `call-policy-handoff.md` when available; do not independently fork the agent's prompt into frontend code.
# Current integration checkpoint — November 20, 2026

Live frontend is branded **lit** at https://shopcall-demo.vercel.app. A/B/C are integrated on `feat/integrations`. Main call now shows actual photo-generation progress and candidate preview, automatic capture uses a shared draft-bound guard, camera state reaches the agent, and Finish opens editable listing previews before the combined proposal freezes. Owner chooses generated copy/photo; nothing is auto-approved. Later new-product approval reuses a verified storefront without another build. Sign out clears old account state and discards late tool responses.

Seven browser fixture scenarios passed against the production frontend. Original merchant publication passed real anonymous browser/catalog verification at https://detailed-difficult-boastmachine.replit.app/. A latest-policy fresh spoken three-item rehearsal and camera-off maintenance run remain manual acceptance. The backend still runs on the demo Mac through temporary HTTPS tunnels. Details: `live-call-fixes.md`, `product-media-handoff.md`, and current README.
