# Product storefront orchestration

This is the **product runtime harness**: an approved merchant brief becomes an ordered specialist plan for one actual Replit storefront. It is not a development test runner and does not claim a native Replit subagent API exists.

## Runtime seam

Import from `src/integrations/orchestrator`:

- `createStorefrontPlan({ businessId, businessName, publicCatalogUrl, catalogRevision, approvedDesignBrief })` returns deterministic plan ID, immutable-snapshot hash and ordered tasks.
- `buildReplitCreationPrompt(plan)` provides a single-app bootstrap prompt.
- `buildTaskPrompt(plan, taskId)` provides follow-up role-specific instructions. The controller uses actual discovered Replit update tools on the **same app ID**. Passing `deploy` throws; publication is controller-owned.
- `assertPlanIntegrity(plan)` detects changed snapshot/task graph before provider operations.
- `evaluateTaskGate(plan, evidence, replId, taskId)` validates the completed dependency prefix before dispatching the next specialist task.
- `evaluateDeploymentGate(plan, evidence, replId)` requires current, same-plan/app, independently observed acceptance evidence before publication.
- `evaluatePublishedGate(...)` additionally requires actual provider-published status and anonymous public page/catalog verification after publication.

Parent publication runtime owns durable job/task state, provider calls, retries, application IDs and verification callbacks. These planning/evidence functions make no provider calls and mutate no merchant data.

## Specialist sequence

1. `design`: approved-style **request association**, responsive storefront and contact-to-buy design. The `approved-style-reference` criterion proves actual rendered preview carries the immutable approved plan ID; it is not an aesthetic judgment. Optional visual review can assess quality separately without becoming an invented provider prerequisite.
2. `frontend`: functional responsive accessible presentation, empty/error states.
3. `catalogIntegration`: live canonical API fetch, exact business ID/current revision, original images and no private data, uncached per-request server rendering and same-origin live catalog proxy.
4. `qa`: actual anonymous preview/browser and live network observations, product values/images and no checkout.
5. `deploy`: external controller invokes actual publication only after all prior gates, then verifies public output.

Design/frontend/catalog/QA can be specialized agent roles executing in sequence within one Replit app. Tool acceptance or model prose saying “done” never establishes completion. No parallel native agents are claimed. Backend authority remains outside generated storefront: no competing product database, inventory edits, owner auth or payment checkout is generated.

## Independently observable storefront contract

Every page request must server-render the current catalog using an uncached external fetch. Fetch/route/page/CDN responses use no-store; static generation and client-only catalog loading do not satisfy this contract. HTML must contain actual listing content and `data-shopcall-business="<business ID>"`, `data-shopcall-revision="<current revision>"`, plus `data-shopcall-product="<product ID>"` for each active product. Actual approved image URLs, prices and stock state render with those listings.

Visible root also carries `data-shopcall-plan="<plan ID>"`, associating the actual preview with its approved request. This marker is not a style-quality score and is compared alongside real content rather than accepted as success by itself.

Generated app also exposes public read-only `GET /api/shopcall/catalog`, a same-origin no-store proxy that fetches the exact canonical public URL anew on every request and returns PublicCatalog unchanged. This proxy is not a second catalog authority and never accepts writes. Upstream failures produce honest errors rather than fake/stale catalogs.

Parent verifier must independently fetch the external canonical catalog, page HTML, same-origin proxy and image assets, then compare identity/revision/product IDs/values. HTML markers are comparison handles, not proof supplied by the generated app. HTTP smoke checks do not replace browser evidence for responsive/accessibility/interaction QA or the final live camera-off update rehearsal.

Read-only controlled failure previews at `?shopcall_verify=empty` and `?shopcall_verify=upstream-error` must visibly state “Verification scenario,” render the same actual state components as real failures, carry visible `data-shopcall-state="empty"` / `"error"` notices with appropriate messages, and contain no product listings. Both are no-store. They do not mutate the canonical catalog, fake real inventory, or prove a normal successful deployment. Normal preview/public checks always use real canonical data.

## Concrete automatic task observer

`ConfiguredPreviewLocator` maps actual Replit app IDs to trusted preview URLs obtained from real structured provider/configuration data. No app editor URL or model-prose URL is automatically accepted. `PlaywrightPreviewInspector` uses the parent anonymous network verifier plus an actual isolated Chrome session to inspect normal desktop/mobile preview, visible exact business/product set/name markers, current catalog revision, immutable plan reference, no horizontal overflow, named visible controls, contact-to-buy, no checkout, no-store responses and both controlled failure previews. It denies all WebSockets and restricts browser HTTP origins to deployment configuration.

`AutomaticStorefrontTaskObserver` converts only those observed check identifiers into task evidence and runs `evaluateTaskGate` before allowing progression. It does not mint arbitrary checks from tool acceptance, mock results, or Agent prose. Missing preview configuration is explicitly blocked; temporary network/browser/content mismatch stays pending for the workflow's bounded timeout. Browser tests are scoped smoke checks, not a claim of complete WCAG compliance or aesthetic quality.

Wire `new AutomaticStorefrontTaskObserver(locator, new PlaywrightPreviewInspector(trustedOrigins, anonymousVerifier))` into `ReplitPublicationAdapter`. The actual Chrome binary and preview URL still need real deployment configuration. This module adds no model provider or API key requirement.

## Approval and untrusted input

Caller must load brief from an actual owner-approved immutable publication snapshot, not from agent-supplied `confirmed: true`. Strict schema rejects unknown fields and malformed/private/literal-IP catalog URLs. Obvious command/instruction override attempts are refused. Remaining merchant strings are JSON-delimited untrusted data; privileged tool operations and publication are enforced outside model prompts. Regex screening is defense in depth, not proof of injection safety. Network layer must still validate DNS/redirect destinations before fetching; URL syntax checks cannot prevent DNS rebinding.

## Evidence contract

`TaskEvidence` includes exact plan/task/app IDs, source, observedAt, passed/failed outcome, redacted artifact reference and acceptance check identifiers. Sources are artifact review, browser check, network check, real provider build/publish metadata or independent reviewer. Unknown sources, including model “done” messages, are rejected. Runtime must obtain evidence through trusted backend verifier callbacks; never accept arbitrary public request bodies as trusted evidence.

Every prepublish task needs complete acceptance coverage, appropriate source, current exact plan/app, successful dependencies with earlier evidence and observations within one hour. Latest failed result blocks publication. Provider build-status alone proves only checks actually observed by the verifier, not accessibility or live data correctness. Postpublish provider metadata and anonymous browser proof are separate observations.

This module validates evidence structure, coverage and scope; it does not perform browser inspection itself. A missing verifier is a hard runtime blocker, not permission to convert Replit model prose into evidence. Final same-URL camera-off update rehearsal remains an additional end-to-end acceptance gate after publication.

Run its local tests with `node --import tsx --test tests/integrations/orchestrator*.test.ts`. Mocked inspector tests establish gate behavior only; they are not evidence that a real preview browser check passed.
