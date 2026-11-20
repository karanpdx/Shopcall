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

Account OAuth/discovery were subsequently verified as described below. Machine-readable build readiness, publication, public runtime/catalog verification, and product-controlled native subagents still require their own evidence. Missing evidence blocks automatic progress rather than reporting fake success.

## Live schema/artifact discovery follow-up

After project OAuth completed, live discovery returned thirteen tools, including `list_app_files`, `read_app_file`, `replit_widget_get_preview_url`, `replit_widget_start_app_preview`, and `replit_widget_get_auth_token`. No native subagent/task-control tool appeared. `ReplitArtifactPort` adds live-schema-validated **source artifact** methods without changing the publication mock interface. Credential/hidden artifact paths are rejected.

Live descriptions for all three widget tools explicitly state: “Internal tool for Replit's app builder. This must not be called directly by the model.” These descriptions were absent from the initial saved schema-only snapshot. Once discovered, all widget methods were removed from production adapters and allowlists. No widget auth token was obtained. Observed widget preview results below are unsupported integration experiments, not a production dependency or documented external authentication flow.

Read-only observations on the parent's explicitly synthetic probe app:

- `list_app_files` has no discovered output schema; actual response uses a text content block with newline-separated relative filenames and directory names ending `/`.
- Probe root contained `artifacts/`; its `shopcall-probe/` directory exposed ordinary Vite/frontend source files. This demonstrates actual artifact listing, not build completion.
- Native preview lookup with empty `timestamp`/`gitSha` returned structured `status:error` and `Timestamp is required`. Real current ISO request time with empty `gitSha` returned `Git SHA is required`. Empty strings cannot be treated as “latest.”
- `ask_question` returned structured `phase:busy` while generation was running; this is not build failure or success.

An unsupported preview lookup experiment using the actual Agent-provided forty-character SHA and real current ISO request time returned `status:ok`, a token-free development URL, and expiration. The URL independently returned HTTP 307 to `https://replit.com/__replshield`, so it did **not** establish a usable anonymous runtime. No documented external token/header/cookie flow was found; no credential interchange was guessed.

`ReplitLivePreviewLocator` in `preview-locator.ts` now uses only documented read-only `ask_question`. Busy/wrong-app responses yield no candidate. Any returned URL remains an **untrusted candidate**, restricted to configured HTTPS Replit preview suffixes with no port, query, credentials, or fragment. The controller must independently inspect actual current HTML, images, catalog, and browser behavior; the locator never asserts readiness or provenance from prose. Dynamic candidate origin must be safely registered with the controller's exact-origin network policy before inspection, rather than pre-mapping a new app ID manually. Private preview shielding remains a possible blocker; production publication workflow therefore uses independent source preflights before publication and actual anonymous browser QA after provider publication, before marking ready/emailing.

## Supported source preflight observer

`ReplitArtifactTaskObserver` supports design, frontend, and external catalog-integration preflights only. It requires a genuine provider `ask_question` structured `phase:paused` response matching the app ID; `paused` establishes Agent idle only, not compilation or acceptance. It independently lists/reads generated source within bounded directory/file/depth/byte limits, excluding hidden/credential/dependency/build directories. Returned evidence uses `artifact-review` and a source SHA-256 reference, never raw source or credentials. The three task acceptance lists are explicitly static artifact checks; runtime behavior, correct current data, accessibility and honest states still require actual post-publication browser/network QA. Changed/oversized/unrecognized artifacts fail closed.

Exports `readSourceInventory(client, replId, limits?)` and `inspectStaticArtifacts(inventory, publicCatalogUrl, planId)` can support diagnostic inspection. Static references cannot independently establish product behavior. Seventeen deterministic Replit tests cover OAuth, schemas, artifact bounds/private path isolation, static evidence separation, unsupported internal widget rejection, candidate URL restrictions, publication-presence handling, and bounded read-only retries without mutation replay. Live filesystem listing/reads succeeded, then intermittently returned provider errors; only safe read operations retry (three attempts maximum), never create/update/publish or Agent questions. Filesystem reads are serialized because concurrent reads were unreliable in the probe.

Targeted serialized source inspection of the synthetic integration probe succeeded after those transient failures: actual provider Agent `phase:paused` matched the probe app; `App.tsx` explicitly identified a synthetic probe and called `useGetProbe()` with loading/error handling. Backend `routes/probe.ts` defined a read-only `/probe` GET JSON handler, `routes/index.ts` imported it, and `app.ts` mounted routes at `/api`. This confirms minimal diagnostic source wiring and provider idle only. Actual build/runtime/publication still require their own provider status plus anonymous HTTP/browser observations.

The live publication profile can set `publication.presencePath: ["found"]` for the discovered status schema. Exact boolean `false` means no current publication state is available yet and remains pending. Missing/nonboolean presence blocks interpretation. This avoids treating a normal short delay after publication scheduling as schema failure; it never infers ready.
