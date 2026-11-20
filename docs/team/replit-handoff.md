# Replit adapter handoff

## Implemented locally

- `src/integrations/replit/oauth.ts`: official MCP SDK OAuth discovery and PKCE flow. `ReplitOAuthService.begin(ownerId)` returns an authorization redirect or existing connection. `complete(ownerId, state, code)` consumes single-use owner-bound state before token exchange. `provider(ownerId)` is used by the MCP client and supports SDK refresh. Fixed configured callback; HTTPS required except loopback development.
- `oauth-store.ts`: `ReplitOAuthStore` repository interface and durable local `EncryptedFileOAuthStore`. Tokens, client registration, discovery state, PKCE verifier and random state are AES-256-GCM encrypted with owner-bound AAD. State is owner-bound, expires after ten minutes, and atomically consumed. SQLite on a persistent volume is suitable only for one backend deployment; hosted/multi-instance production needs repository implementation with equivalent transactions and managed encryption key.
- `client.ts`: Streamable HTTP client at the documented endpoint. Live paginated tool discovery, allowlisted tools, JSON Schema validation of every input, bounded requests, secret-safe errors. `createApp`, `updateApp`, `askBuildReadiness`, `publishApp`, `getPublishStatus` return raw typed tool results. Unknown schema or capability stops the operation.
- `results.ts`: strict explicit profile for observed structured provider output. **No guessed response profile is included.** No profile/unknown output is blocked; prose/text JSON does not become provider build evidence. A published status/URL still requires independent anonymous runtime verification before readiness or notification.
- `scripts/replit-connect.ts`: loopback CLI OAuth helper, default callback `http://127.0.0.1:8788/api/replit/callback`. Local credentials live in ignored `.shopcall`; generated local encryption key is permission-restricted. It does not read Codex credentials.
- `scripts/replit-check.ts`: read-only live discovery after project OAuth; writes names/input/output schemas to ignored `.shopcall/replit-tools.json`, never raw tokens.

## Integrate with B's routes

Instantiate OAuth service server-side with a deployment-configured callback and encrypted repository. Derive `ownerId` from authenticated session, never request JSON/query. `POST /api/replit/connect` checks owner session and origin/CSRF before `begin`; callback requires the same session and validates `state` through `complete`. Never serialize stored tokens or provider instance to client. Do not repurpose CLI fixed demo-owner ID for public routes.

`ReplitMcpClient.connect(service.provider(ownerId))` authenticates one owner. Close it after work. Persist returned app ID immediately, and reconcile unknown remote mutation outcomes instead of blindly creating another app. `ReplitResponseProfile` must be populated only after observing real account responses and machine-readable build status; `verifiedAt` is a configuration record, not independently established evidence. Never map an LLM `ask_question` answer to an actual compiler/build receipt.

CLI commands (parent coordinates package scripts):

```sh
node --env-file=.env.local --import tsx scripts/replit-connect.ts
node --env-file=.env.local --import tsx scripts/replit-check.ts
```

Optional local env: `DEMO_OWNER_ID`; `REPLIT_REDIRECT_URI`. Production encryption: `REPLIT_CREDENTIAL_KEY`, exactly 32 random bytes encoded base64. Local helper creates private `.shopcall/replit.key` when absent; do not commit/copy it or deploy that local pattern as managed key storage. No endpoint needs a fabricated Replit API key.

## Product harness capability boundary

The [official MCP tool list](https://docs.replit.com/platforms/mcp-server) documents app create/update/publish/search/list/question/status operations. It does not document external create-subagent, start-task, merge-task, or task-status APIs. The [native task board](https://docs.replit.com/features/agent/task-board) describes isolated Agent tasks, dependency queueing, review/apply, and conflict integration in Replit's interface. These native tasks are not automatically exposed as public MCP task tools.

Therefore product can safely orchestrate one app with role-scoped **sequential** `update_app_using_prompt` calls using the same stable `replId`. It cannot honestly claim externally controlled parallel Replit specialist subagents until live tool discovery verifies such a capability. Asking Agent to internally plan UI/backend/deployment tasks is possible as a prompt, but separate agent IDs, isolation, completion, and merges are not observed guarantees. Creating an independent Replit app per specialist produces multiple apps and does not solve integration.

## Verification and remaining gates

Six deterministic tests cover credential encryption/owner isolation, state expiry/replay, SDK PKCE bridge, discovered-schema validation, conservative result parsing, and provider-error redaction. These use local/mocked provider fixtures and do **not** establish live OAuth/build/publication.

Live read-only public OAuth metadata discovery passed through the official SDK on November 20, 2026: resource `https://mcp.replit.com/server/mcp`, authorization server `https://replit.com/oidc`, dynamic registration `/oidc/reg`, authorization `/oidc/auth`, token `/oidc/token`, PKCE `S256`. No account authorization or app mutation occurred.

Actual project OAuth, live account tool discovery, observed response profile, machine-readable build readiness, create/update publication, public runtime/catalog verification, and product-controlled native subagents remain unverified. Missing evidence blocks automatic progress rather than reporting fake success.
