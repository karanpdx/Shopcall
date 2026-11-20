# Person C — ElevenLabs, Replit OAuth, jobs, email

## Ownership

Own `src/integrations/**`, `scripts/**`, `tests/integrations/`. Coordinate package manifests/lockfile, `.env.example`, root config. Export provider functions for B to call; B owns all `src/app/api/**` route files. Do not edit frontend pages or database implementations.

## Prove hard dependencies first

1. ElevenLabs: onboarding → read-only connection check (`npm run agent:setup`) → provision a dedicated authenticated agent → session credential issuance → one real browser call and client-tool result with A. Scaffold has SDK factory, not a provisioned agent or conversation.
2. Replit: app-owned OAuth with protected-resource discovery and Streamable HTTP at `https://mcp.replit.com/server/mcp`. Use official MCP SDK; persist server-only tokens securely. Bind OAuth state/PKCE to authenticated owner, validate callback, support refresh. Codex authentication is not backend authentication.
3. Discover actual tools and schemas. Docs currently list `create_app_from_prompt`, `ask_question`, `publish_app`, and `get_publish_status`; inspect real responses. Prove create → actual build readiness → publish → anonymous verification. Never infer build-ready from create accepted or publish-status alone.

## Build in this order

- Private agent prompt: concise, one question at a time, owner is authority for price/stock, clarify ambiguous identity and “sold it.” Use typed client tools forwarding to same-origin authenticated backend. Initial tool names are in `src/contracts/integrations.ts`; coordinate exact schema with A/B. No raw SQL/unrestricted apply tool.
- Add backend voice session issuance with `createElevenLabsClient`; keep key server-only. Reconnect should preserve B's catalog/drafts.
- Bind vision results to stored capture/draft IDs. Choose provider with available credentials; visible attributes only, no invented stock/price. Original photo remains canonical. Enhancement is stretch.
- Implement DB-backed publication worker using B's `PublicationRepository`. Persist Replit app ID as soon as returned. Resume/reconcile jobs after crash; do not blindly create duplicate apps when remote outcome is unknown. One active build per store; bounded retries/timeouts and honest failure state.
- Generate a Replit frontend using the approved design brief and live `publicCatalogUrl`. The generated app must fetch current catalog at runtime, never compile prices/stock into constants. No deployment fallback.
- Verify anonymous HTTP/page identity, current product IDs/revision and usable images, then mark ready. Preserve last working URL on failed revision.
- Real email only after URL verification. Provider accepted/sent/delivered are separate states. Failure stays visible in authenticated status UI.

## Handoffs

- A needs browser session options, exact tool schemas, errors and client callbacks.
- B needs exported functions for OAuth start/callback, session issuance, job execution and email; avoid implementing overlapping API routes.
- Public backend hostname, durable storage, email sender/recipient and deployment account remain setup gates, not claimed working features.

## Acceptance

- Invalid OAuth state and replayed callback rejected; secrets redacted.
- Duplicate/restarted jobs do not create repeated publication or send unverified success mail.
- Provider errors/timeouts yield honest failed/retryable state.
- Generated Replit site anonymously loads correct store and fetches updated catalog at same URL after second camera-off call.
- Record actual provider evidence separately from mocked contract tests.

Official references: [Replit MCP](https://docs.replit.com/platforms/mcp-server), [ElevenLabs React](https://elevenlabs.io/docs/eleven-agents/libraries/react), [ElevenLabs client tools](https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools).
