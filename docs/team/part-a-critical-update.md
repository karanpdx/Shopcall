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
