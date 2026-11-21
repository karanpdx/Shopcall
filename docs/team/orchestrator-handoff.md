# Product storefront orchestration

This is the **product runtime harness**: an approved merchant brief becomes an ordered specialist plan for one actual Replit storefront. It is not a development test runner and does not claim a native Replit subagent API exists.

## Runtime seam

Import from `src/integrations/orchestrator`:

- `createStorefrontPlan({ businessId, businessName, publicCatalogUrl, catalogRevision, approvedDesignBrief })` returns deterministic plan ID, immutable-snapshot hash and ordered tasks.
- `buildReplitCreationPrompt(plan)` provides a single-app bootstrap prompt.
- `buildTaskPrompt(plan, taskId)` provides follow-up role-specific instructions. The controller uses actual discovered Replit update tools on the **same app ID**. Passing `deploy` throws; publication is controller-owned.
- `assertPlanIntegrity(plan)` detects changed snapshot/task graph before provider operations.
- `evaluateTaskGate(plan, evidence, replId, taskId)` validates the completed dependency prefix before dispatching the next specialist task.
- `evaluateDeploymentGate(plan, evidence, replId)` requires current, same-plan/app **static source-artifact preflight** for the first three tasks before provider publication. It never claims real browser behavior from source artifacts.
- `evaluatePublishedGate(...)` requires actual provider-published status, full postpublication QA and final independent anonymous public page/catalog verification before ready/email/public URL exposure.

Parent publication runtime owns durable job/task state, provider calls, retries, application IDs and verification callbacks. These planning/evidence functions make no provider calls and mutate no merchant data.

## Specialist sequence

1. `design`: static `approved-style-reference`, `design-artifacts`, `contact-integration-artifacts`. Actual source must reference the immutable approved request/design and contain storefront/contact design artifacts. This is request association and source preflight, not aesthetic or rendered acceptance.
2. `frontend`: static `frontend-artifacts`, `accessible-control-artifacts`, `failure-state-artifacts`. Inspect actual source, not a completion message. Source presence does not prove runtime accessibility/responsiveness/error behavior.
3. `catalogIntegration`: static `catalog-fetch-artifacts`, `canonical-endpoint-reference`, `catalog-proxy-artifacts`, `no-catalog-write-artifacts`. Inspect actual canonical fetch/proxy/authority boundaries before deployment.
4. `deploy`: external controller invokes supported provider publication after static preflight. Provider-published output becomes a candidate URL; it is not yet reported ready or emailed.
5. `qa`: actual public browser/network verification after provider publication. Required criteria include anonymous page, live catalog/current products, contact-to-buy/no checkout, desktop/mobile rendering, named controls, real failure scenarios and approved-plan association. Final independent public proof must also pass before ready/email.

Design/frontend/catalog/QA are specialized task roles around one Replit app. Supported read-only artifact list/read tools may establish **static preflight only**; a paused build status establishes idle/readiness to inspect, not source correctness or browser success. Tool acceptance or model prose saying “done” never establishes acceptance. No parallel native agents are claimed. Native preview may be protected by Replit's authentication shield; this runtime does not bypass it or invoke internal widget-only tools. True rendered QA uses provider-published public output. Backend authority remains outside generated storefront: no competing product database, inventory edits, owner auth or payment checkout is generated.

## Independently observable storefront contract

Every page request must server-render the current catalog using an uncached external fetch. Fetch/route/page/CDN responses use no-store; static generation and client-only catalog loading do not satisfy this contract. HTML must contain actual listing content and `data-shopcall-business="<business ID>"`, `data-shopcall-revision="<current revision>"`, plus `data-shopcall-product="<product ID>"` for each active product. Actual approved image URLs, prices and stock state render with those listings.

Visible root also carries `data-shopcall-plan="<plan ID>"`, associating the actual preview with its approved request. This marker is not a style-quality score and is compared alongside real content rather than accepted as success by itself.

Generated app also exposes public read-only `GET /api/shopcall/catalog`, a same-origin no-store proxy that fetches the exact canonical public URL anew on every request and returns the normalized PublicCatalog presentation projection below. This proxy is not a second catalog authority and never accepts writes. Upstream failures produce honest errors rather than fake/stale catalogs.

### B canonical wire adapter

`parseCanonicalCatalog(raw, plan): NormalizedPublicCatalog` accepts B's real `{ok:true,data}` response from `/api/public/<slug>/catalog` and the classic plain normalized contract used by earlier C tests. B fields are `business.slug`, `catalogRevision`, product `name`, `priceCents`, `inventoryCount`, derived `soldOut`, metadata, and `generatedAt`; they are not the original scaffold field names. `getExpectedPublicSlug(plan)` infers the exact approved slug from the trusted approved endpoint path. B returned slug must match it before the adapter binds internal approved `businessId` into the normalized presentation marker. Identity is proved by approved trusted endpoint + matching public slug; B does not publicly return that UUID.

Normalized shape is `{business:{id,name,description,contactEmail,currencyCode},revision,products:[{id,title,description,priceMinor,currencyCode,quantityOnHand,inventoryTracked,imageUrl}]}`. Nullable descriptions become empty strings. B inventory is always tracked and USD; cent amounts remain integers. A null contact email blocks readiness rather than inventing an address. Sold-out contradictions, duplicate IDs, wrong slug/UUID, stale catalog revisions, API errors and private/unknown schema fields are rejected.

`generatedAt`, product `revision`/`updatedAt`, category/featured flags and hero/style metadata do not belong to this presentation projection. They are excluded from semantic comparisons so generation timestamps cannot cause false stale-catalog failures. Products sort by stable ID; actual prices, quantities, product images, names, descriptions, business details and catalog revision remain authoritative and must match. Generated SSR and same-origin proxy use this same documented mapping on every fetch; they never hardcode inventory or persist an alternative catalog.

Parent verifier must independently fetch the external canonical catalog, page HTML, same-origin proxy and image assets, then compare identity/revision/product IDs/values. HTML markers are comparison handles, not proof supplied by the generated app. HTTP smoke checks do not replace browser evidence for responsive/accessibility/interaction QA or the final live camera-off update rehearsal.

Read-only controlled failure previews at `?shopcall_verify=empty` and `?shopcall_verify=upstream-error` must visibly state “Verification scenario,” render the same actual state components as real failures, carry visible `data-shopcall-state="empty"` / `"error"` notices with appropriate messages, and contain no product listings. Both are no-store. They do not mutate the canonical catalog, fake real inventory, or prove a normal successful deployment. Normal preview/public checks always use real canonical data.

## Concrete automatic task observer

`ConfiguredPreviewLocator` remains a trusted URL lookup utility; it does not authorize protected preview access. The automatic browser observer uses only `run.candidateUrl` after actual provider publication during `verifying`, never a native preview fallback. `PlaywrightPreviewInspector` uses the parent anonymous network verifier plus an actual isolated Chrome session to inspect normal desktop/mobile public output, visible exact business/product set/name markers, current catalog revision, immutable plan reference, no horizontal overflow, named visible controls, contact-to-buy, no checkout, no-store responses and both controlled failure previews. It denies all WebSockets, closes popups and restricts browser HTTP origins to deployment configuration.

`AutomaticStorefrontTaskObserver` accepts only task `qa` in phase `verifying`. It converts observed public browser checks into task-scoped evidence and requires actual provider-published plus earlier static-artifact evidence through `evaluateTaskGate`. It does not mint arbitrary browser checks from tool acceptance, mock results, or Agent prose. Missing candidate output or temporary network/browser/content mismatch stays pending for the workflow's bounded timeout. Browser tests are scoped smoke checks, not a claim of complete WCAG compliance or aesthetic quality.

Compose Replit's concrete supported artifact observer for the first three tasks with `new AutomaticStorefrontTaskObserver(locator, new PlaywrightPreviewInspector(trustedOrigins, anonymousVerifier))` for postpublication `qa` in `ReplitPublicationAdapter`. The actual Chrome binary and trusted provider-published origin need real deployment configuration. This module adds no model provider or API key requirement.

## Approval and untrusted input

Caller must load brief from an actual owner-approved immutable publication snapshot, not from agent-supplied `confirmed: true`. Strict schema rejects unknown fields and malformed/private/literal-IP catalog URLs. Obvious command/instruction override attempts are refused. Remaining merchant strings are JSON-delimited untrusted data; privileged tool operations and publication are enforced outside model prompts. Regex screening is defense in depth, not proof of injection safety. Network layer must still validate DNS/redirect destinations before fetching; URL syntax checks cannot prevent DNS rebinding.

## Evidence contract

`TaskEvidence` includes exact plan/task/app IDs, source, observedAt, passed/failed outcome, redacted artifact reference and acceptance check identifiers. Sources are artifact review, browser check, network check, real provider build/publish metadata or independent reviewer. Unknown sources, including model “done” messages, are rejected. Runtime must obtain evidence through trusted backend verifier callbacks; never accept arbitrary public request bodies as trusted evidence.

Every prepublish task needs complete **static artifact** coverage, artifact-review/independent-review provenance, current exact plan/app, successful earlier dependencies and observations within one hour. Latest failed result blocks publication. Real provider build-status alone does not prove source correctness, accessibility or live data. QA must follow actual provider-published status, and final public proof must follow QA. A public candidate may exist during verification; application never exposes it as verified-ready or emails success until all checks pass.

Pure evidence helpers validate structure, coverage and scope; the concrete inspector actually performs public network/browser observations. A missing supported artifact reader or public browser verifier is a real blocker, not permission to convert Replit model prose into runtime success. Final same-URL camera-off update rehearsal remains an additional end-to-end acceptance gate after publication.

Run its local tests with `node --import tsx --test tests/integrations/orchestrator*.test.ts`. Mocked inspector tests establish gate behavior only; they are not evidence that a real preview browser check passed.
