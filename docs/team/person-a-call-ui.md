# Person A — Call UI and capture

## Ownership

Own `src/features/call/**`, `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/globals.css`, and other non-API app pages. Own UI tests under `tests/ui/`. Do not edit `src/app/api/**`, `src/server/**`, `src/integrations/**`, or shared contracts without coordination.

## Build in this order

1. Fixed-demo-owner login screen using B's session route. Add consent copy: mic for conversation, optional camera, selected images uploaded, no full video recording by default.
2. Responsive call screen with start/end, mute, optional camera, camera toggle, facing-mode switch, connection/error states. Wire ElevenLabs browser SDK using C's backend-issued session credential. Never put API key in browser.
3. Product draft tray with stable IDs, incomplete fields, actual saved status, original photo previews, retake/upload fallback. Camera capture must return the draft ID it started with even if active product changes during upload.
4. Typed client-tool handlers. Forward data operations to B's authenticated routes, handle local camera/UI tools in browser. Return tool success only after backend response.
5. Review panel for product fields, publication contact info, and price/stock proposals. Owner clicks explicit confirm; this calls B's confirmation route. Voice tool merely opens panel; it cannot fabricate approval.
6. Persistent status page. Show only actual job state and verified public URL, including failed/retry states. Returning call starts with camera off and loads existing catalog.

## Handoffs

- Consume `ApiResult`, `Product`, `PublicCatalog`, and `BuildJob` from `src/contracts`.
- C owns agent prompt/tool schemas and session issuance; B owns API route plumbing. Request additions through them.
- Use `docs/api-contract.md`. No intended endpoint except `/api/health` exists in scaffold. During UI development, clearly label fixtures and keep them out of real success states.

## Acceptance

- Turning camera off stops camera tracks and captures while audio continues.
- Camera denied: upload fallback works; voice call remains possible.
- Ending/unmounting cleans up streams and voice session.
- Async capture A never attaches to draft B.
- Product image/name correction remains possible before approval.
- Keyboard/mobile accessible controls, labels, focus states, readable error states.
- No checkout/payment UI; storefront is contact-to-buy.
