# Call-to-Storefront
## Product Requirements Document + Technical Implementation Specification

**Version:** 1.0
**Date:** November 20, 2026
**Purpose:** Coding-agent handoff for a Replit-sponsored, single-day hackathon
**Tracks:** Small Business & Creators (primary); Student & Community Needs / Climate & Resource Efficiency (secondary)
**Working tagline:** *Show your inventory. Tell us your story. Get a storefront—and keep it updated with a call.*

> **Directive to implementation agents:** Deliver a functioning end-to-end demonstration before adding breadth. The crucial path is (1) conversational video call, (2) product capture with correct details, (3) working published storefront link, and (4) second voice-only call that changes that **same** storefront's product price/stock. Persist catalog data outside generated site code. Never fabricate evidence of a completed Replit build, live publication, or email delivery. Keep the experience understandable to a business owner who has never coded.

---

# 1. Executive summary

**Call-to-Storefront** lets small business owners create and operate an online storefront through an ordinary, phone-friendly video/voice conversation. An ElevenLabs conversational voice agent interviews the owner about their business, asks them to show physical products to their camera, captures useful product images, identifies and confirms product details (name, description, price, stock, variations), and uses Replit to build/publish a storefront. The owner can hang up and receive an email when the working site is ready. Subsequent calls—camera on or off—can update listings, prices, stock, availability, and store design with natural-language requests. The public site updates using a canonical persistent catalog; a full code rebuild should not be required for ordinary inventory edits.

**Value proposition:** A nontechnical owner can express their business in the way they already understand it: by showing products and talking about them. The product turns that conversation into a functioning storefront instead of asking the owner to learn a site builder, upload inventory into forms, or manually edit website code.

**Primary user:** Solo merchants and microbusinesses such as handmade ceramics sellers, jewelry makers, artists, local craftspeople, and vintage/resale shops. **First demo persona:** Owner of a handmade ceramics studio with 3 items: blue mug ($24, quantity 4), white bowl ($32, quantity 2), tall vase ($45, quantity 1). All values are sample/demo data only.

**MVP purchasing assumption:** Public site offers product browsing and **contact-to-buy / inquiry**, not end-to-end checkout. A store can show availability and an email/contact CTA. Do not integrate payment or promise order handling unless the essential prototype is complete. Do not include fake checkout.

**Hackathon success moment:** During call #1, owner states a rule and captures product inventory; site is published. During call #2 with camera **off**, owner says “The tall vase sold out and the blue mug is now $20”; after confirmation, the **same published URL** reflects sold-out status and price $20, without generating an entirely new website.

---

# 2. Goals, non-goals, metrics

## 2.1 Goals (P0)
1. Browser-based responsive call UI that feels like a video call, supporting microphone, optional camera, camera on/off during a call, switch between front/back cameras where device permits, mute, end call, and clear status.
2. ElevenLabs voice conversation that elicits business and product information, can request still captures, and can invoke typed backend tools.
3. Capture high-resolution still images from local camera, associate captures with the correct product, save original image permanently, and show a user-reviewable thumbnail. Support upload fallback.
4. Extract draft listing fields from video frames and spoken descriptions. Explicitly confirm price, currency, stock, and identity before publishing or mutating them.
5. Create a business profile plus a canonical structured product catalog that survives call termination and deployment.
6. Produce a public, responsive storefront with those items, images, prices, availability, and a real contact CTA; use Replit's documented app-generation/publishing workflow when technically available.
7. Provide async build/publish status; send a real notification email containing the *verified* public URL after successful publication. Surface failures honestly.
8. Reconnect later to the same store and alter existing listing price, stock, and availability through a **voice-only** call.
9. Show an end-to-end demo with visible evidence of data correctness and a real public link.

## 2.2 Stretch goals (P1/P2)
- Photo background removal, conservative relighting and aesthetically coherent product imagery.
- New product added via returning video call.
- Owner-approved suggested pricing based on own stated costs, margins, and existing prices (never claim live market comparisons without sources).
- Store style update through conversation and Replit app-update flow.
- Variants (size/color), categories, taxonomies, shipping/pickup, social links, business story, custom logo.
- Email/SMS update receipt, product change history, undo/rollback.
- Complete e-commerce checkout, inventory decrement after authenticated payments, domains, multi-merchant self-service onboarding.

## 2.3 Non-goals for hackathon
- Real-time continuous object tracking across full video; use selected still frames.
- Training a custom image classifier.
- Unlimited item counts, arbitrary product types, or fully autonomous inventory inference.
- Automated scraping of competitor listings and unsourced “market prices.”
- Medical/safety-critical product advice or inspection.
- Auto-deploying unreviewed malicious or unsafe code.
- Invisible/background microphone or camera recording.

## 2.4 Acceptance criteria
- Demo call creates one store with three nonduplicate products, accurate named prices and quantities, and one usable image per listing.
- User can say “No, that is the white bowl” and correct an incorrectly associated image/description before publication.
- Camera can be toggled off without disconnecting audio; catalog updates work with camera off.
- A public URL loads on an incognito browser, not just an owner's authenticated session.
- Returning call modifies exactly the intended product record and the published site reflects the change on reload.
- If ambiguous (“the vase sold”), agent asks whether sold **one** or **all / sold out**; never silently assume.
- If a build/publish job fails, the UI/email reports failure; no fabricated success or URL.

---

# 3. Product experience

## 3.1 Primary journey: first-time merchant
1. Open landing page. Headline: **“Build your storefront with a video call.”** CTA: **“Start my store”**. Explain camera optional, voice required for voice-first path, and that products are published only after review.
2. Ask for business name and email (minimum viable owner identity). Authenticate via verified email magic link/OTP, or clearly constrain hackathon demo to a fixed authenticated demo account. No unauthenticated public store-edit link.
3. Request mic permission; camera permission optional. Call screen shows own preview, agent speaking/listening indicator, capture thumbnails, status text, and end call control.
4. ElevenLabs agent asks what the business makes/sells, audience, brand story, visual style, preferred colors, contact method, shipping/pickup preferences. It maintains a structured brief; no requirement to fill a large form.
5. Agent asks owner to show **one item at a time**. Owner describes each item while holding/showing it. Agent asks for missing fields (“How much? How many available?”), guides camera to improve framing, and requests a high-res capture via a frontend client tool.
6. A still image is captured, uploaded, and associated with the current product draft ID. Vision analyzes that still; speech provides product attributes. Present image and listing card; voice agent clarifies uncertainties and confirms final name, price and quantity. If vision and owner conflict, owner's explicit correction wins.
7. Repeat for two or three items. Keep a visual tally of complete and incomplete products.
8. Agent summarizes the store and listing data. Owner approves **Publish** explicitly (voice confirmation paired with clickable confirm is ideal) and ends the call. Must be clear whether confirmation authorizes public posting of images and contact info.
9. Backend freezes a snapshot/manifest of publication inputs, begins/continues a Replit generation job, assembles storefront around canonical catalog API, verifies the published URL, and sends email with the URL.
10. Owner can visit a status page immediately after hangup and refresh for status, even if email delivery fails.

## 3.2 Returning journey: voice-only update
1. Owner opens authenticated “Call my storefront” page, camera starts off by default if preferred.
2. Agent greets with correct business context and can reference verified existing catalog summaries.
3. Owner says “The tall vase sold out; change the blue mug price to $20.”
4. Agent resolves product identities using canonical product IDs and titles/aliases; presents proposed changes and confirms them. “Tall vase: stock 1 → 0; blue mug: $24 → $20. Apply both?”
5. Backend applies a validated, atomic/transactional batch (if supported) with audit events.
6. UI confirms application only after backend success. Public site reads fresh catalog state and reflects changes on reload; cache invalidation/revalidation if needed.
7. Owner hangs up. No rebuild for ordinary updates. Optional short summary/receipt.

## 3.3 Returning journey: add a product
- Owner turns camera on mid-call; agent guides capture and creates draft, then confirms all fields and uploads image.
- Owner approves publish of the new item. Backend commits catalog; public website shows new item from dynamic API.
- If generated storefront had hardcoded products, that is a bug: catalog must not be embedded as stale constants.

## 3.4 Returning journey: redesign storefront
- Owner asks “Make it more minimal with cream and dark green.” Agent previews the interpreted request. Owner confirms.
- Replit update job receives **design-only** request and explicit catalog API contract. Track as separate `storefront_revision` from inventory changes. New frontend must not overwrite catalog records.
- Production site continues serving last published version until successful replacement. Roll back on failure.

## 3.5 Agent persona
- Helpful, concise, conversational, friendly, not excessively enthusiastic.
- Ask **one question at a time**, using what user already said. Briefly recap details when needed.
- Do not interrupt owner with verbose photo-processing narration.
- Ask for missing prices and stock; do not hallucinate facts from images.
- Never state something is saved, built, published, emailed, or live until the backend returns success.
- On ambiguity, ask precise follow-up. On uncertainty in visual identity, say “I’m not sure I matched that photo; is this the blue mug?”
- Price suggestions must be optional and always justified as estimates based on supplied inputs; owner decides.

## 3.6 UI sketches (descriptive)
**Landing:** headline, three-step process (“Call → Show products → Receive your store”), Start call, small trust/privacy notice.

**Call screen (mobile-first):** fullscreen camera self-preview (optional), subtle audio wave/agent activity area, active product chip (“Capturing Blue Mug”), thumbnail strip for captured photos, small listing tray, call controls pinned bottom (mic, camera, switch camera, capture manually, end), status pill (“3 products collected”). Do not obscure camera view with transcript walls; show expandable transcript/notes.

**Post-call:** “Your storefront is being built” with real status phases (received / assets prepared / building / publishing / ready or failed). Link only when ready. User can inspect and correct drafts in a review step if necessary.

**Public storefront:** brand hero, product grid, product detail, honest stock labels and contact-to-buy button. Mobile layout. Accessible alt text, currency formatting, no broken images.

---

# 4. Architecture

```text
Merchant browser (responsive React/Next.js)
  ├── camera/mic MediaDevices + frame capture + uploads
  ├── ElevenLabs client conversation SDK (voice in/out)
  ├── client tools (capture_frame, preview_product, show_confirmation)
  └── HTTPS API / WebSocket or SSE for status
                     |
                 App backend
  ├── auth + ownership + sessions
  ├── ElevenLabs server tool handlers / verified callbacks
  ├── call state + structured requirements extraction
  ├── image storage + optional image enhancement worker
  ├── canonical catalog DB + transactional mutations
  ├── build job orchestrator + Replit MCP OAuth client
  ├── public catalog API for storefront
  ├── webhook verification / job status / retries
  └── email provider
                     |
  ┌──────────────────┼─────────────────────┐
 DB (Postgres)  Object storage       Replit MCP
                  (originals & edited)   create / update / publish
                     |                     |
                     └────── storefront ───┘
                         live public site
                         fetching catalog
```

**Architecture rule:** Replit-generated frontend is a presentation layer. The app's backend owns businesses, products, photo metadata, pricing, quantity, and catalog revision numbers. Never store authoritative product state only in a generated source file, in conversation transcript text, or in an LLM prompt.

## 4.1 Recommended stack (substitute if existing repo differs)
- **Web client:** Next.js + TypeScript + Tailwind; responsive and accessible.
- **Backend:** Next.js route handlers or Node/Fastify; TypeScript and shared Zod schemas.
- **DB:** Postgres (e.g., hosted managed DB) with Prisma or Drizzle migrations. For local demo SQLite is okay only if public storefront can safely read persistent state; don't rely on temporary in-memory state.
- **Storage:** S3-compatible object storage or hosted storage with signed uploads; preserve original images.
- **Voice:** ElevenLabs Conversational AI/Agents Web SDK with tools for invoking UI actions; keep secrets server-side.
- **Vision:** an image-capable model called by backend on selected saved frames, yielding structured observations; provider configurable. Do not trust vision outputs without validation.
- **Image editing:** asynchronous task with explicit prompt to preserve product identity; fallback to original crop/background cleanup. Original always available.
- **Build:** Replit MCP client authenticated using supported OAuth flow. Confirm available methods in official current docs before implementation.
- **Email:** Resend/SendGrid or established transactional sender; verified domain if needed. For demo, use a tested address and record delivery status (accepted != delivered).
- **Jobs:** DB-backed queue with retry policy or a durable job runner; local in-process jobs acceptable only for a staged demo with explicit limitation.

## 4.2 External integration prerequisites (must verify early)
1. Can this account authenticate a standalone custom MCP client to Replit using OAuth, from the intended runtime?
2. Can it call Replit's documented app-creation, app-update, publish, and publish-status methods? Confirm **actual tool identifiers and arguments from discovery**, not this document's pseudocode.
3. Does app generation return a stable app ID? How do we determine **build completion** separately from publish completion? Test with a trivial prompt. Do not infer build completion from an issued request.
4. Can generated Replit app access your public, read-only catalog API and image URLs from its deployed runtime? Validate CORS, API base URL, and deployed env.
5. Can a published URL be verified anonymously, and can the same URL serve updated product state without rebuilding?
6. Can ElevenLabs agent call the needed client and server tools in your configured agent/SDK, and can the browser add latest image observations to agent context?

**Timebox / fallback gate:** Test Replit create → finish → publish → verify first. If unsupported within the sprint, implement a clearly labeled fallback: generate a live demo storefront from a trusted template on a separate deployment, and show the Replit-generated-app prompt/handoff without claiming successful Replit automation. Never fabricate a working integration.

---

# 5. Canonical data model

Use UUIDs and timestamps in UTC. Monetary values are integer minor units (e.g., USD cents). Store owner-visible currency per store; no floating-point prices. Product quantities are integers >= 0 or null for intentionally untracked stock.

## 5.1 Tables

**users**
- `id UUID PK`, `email unique`, `email_verified_at`, `created_at`.

**businesses**
- `id UUID PK`, `owner_user_id FK`, `name`, `slug unique`, `description`, `brand_style_json`, `contact_email`, `currency_code` default `USD`, `fulfillment_settings_json`, `status` (`draft|active|paused`), `catalog_revision bigint`, `created_at`, `updated_at`.

**products**
- `id UUID PK`, `business_id FK`, `sku nullable`, `slug`, `title`, `description`, `price_minor bigint nullable`, `currency_code`, `quantity_on_hand integer nullable`, `inventory_tracked boolean`, `status` (`draft|active|archived`), `category nullable`, `attributes_json`, `sort_order`, `revision bigint`, `created_at`, `updated_at`.
- Unique `(business_id, slug)`; index `(business_id, status)`.
- Derive `sold_out = inventory_tracked && quantity_on_hand === 0`; do not use conflicting separate authoritative boolean.

**product_images**
- `id UUID PK`, `product_id FK`, `original_object_key`, `enhanced_object_key nullable`, `thumbnail_object_key nullable`, `selected_variant` (`original|enhanced`), `mime_type`, `width`, `height`, `alt_text`, `capture_session_id`, `capture_timestamp`, `enhancement_status`, `sort_order`, `created_at`.
- Enhanced images never replace originals.

**calls**
- `id UUID PK`, `business_id nullable`, `owner_user_id`, `provider_conversation_id nullable`, `mode` (`create|update`), `started_at`, `ended_at`, `camera_enabled_at_end`, `summary_json`, `transcript_object_key nullable`, `status`, `consent_record_json`.
- Transcript retention configurable and disclosed. Do not store continuous video by default.

**product_drafts**
- `id UUID PK`, `call_id FK`, `business_id FK`, `temporary_label`, `observations_json`, `inferred_fields_json`, `explicit_owner_fields_json`, `missing_fields_json`, `state` (`collecting|awaiting_confirmation|confirmed|discarded`), `product_id nullable`, `created_at`, `updated_at`.

**catalog_change_events**
- `id UUID PK`, `business_id FK`, `product_id nullable`, `call_id nullable`, `actor_user_id`, `change_type`, `before_json`, `after_json`, `idempotency_key unique`, `created_at`.

**build_jobs**
- `id UUID PK`, `business_id FK`, `requested_by`, `reason` (`initial|redesign|feature_update`), `state` (`queued|preparing|creating|building|publishing|verifying|ready|failed`), `replit_app_id nullable`, `published_url nullable`, `spec_snapshot_json`, `catalog_revision_at_request`, `attempt_count`, `last_error_safe`, `created_at`, `updated_at`, `completed_at nullable`.

**notifications**
- `id UUID PK`, `business_id FK`, `build_job_id FK`, `recipient`, `type`, `status` (`queued|sent|failed`), `provider_message_id nullable`, `attempts`, `created_at`, `sent_at nullable`.

## 5.2 Invariants
- Every product has immutable ID; catalog updates target IDs, never positional index.
- An image capture is attached to a `product_draft_id`, never inferred from “currently active” at delayed processing time.
- Owner-supplied explicit values take priority over model guesses; conflicts must be confirmed.
- Publication requires title, at least one usable image (or a clear, explicit no-image choice), valid `price_minor`, confirmed stock policy, contact path, and owner approval.
- Edits increment product and store revisions in the same DB transaction.
- Catalogue changes cannot be lost because a site build uses an old snapshot; storefront fetches live catalog.
- Do not let public storefront mutate stock or prices through the read-only catalog endpoints.

---

# 6. API contracts and action schemas

All authenticated management endpoints require valid owner authentication and business-level authorization. Use CSRF protection where cookies are involved; enforce rate limits and request validation. Path names below are **proposed internal app API routes**, not claimed Replit/ElevenLabs API names.

## 6.1 Owner backend endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/businesses` | Create draft business |
| `GET` | `/api/businesses/:id` | Fetch owned store + status |
| `POST` | `/api/calls` | Create call session; issue short-lived ElevenLabs conversation credential if supported |
| `POST` | `/api/calls/:id/end` | Finalize call and preserve structured summary |
| `POST` | `/api/captures/init` | Create capture record and return signed upload URL |
| `POST` | `/api/captures/:id/complete` | Confirm upload, queue vision/thumbnail work |
| `POST` | `/api/product-drafts` | Create product draft during call |
| `PATCH` | `/api/product-drafts/:id` | Apply observations/corrections; revision guard |
| `POST` | `/api/product-drafts/:id/confirm` | Explicitly confirm listing and commit |
| `POST` | `/api/catalog/resolve` | Resolve natural-language product references using DB context |
| `POST` | `/api/catalog/changes/preview` | Validate and summarize proposed changes without applying |
| `POST` | `/api/catalog/changes/apply` | Apply owner-confirmed changes with idempotency key |
| `POST` | `/api/build-jobs` | Queue initial build or redesign |
| `GET` | `/api/build-jobs/:id` | Poll build/publish status |
| `POST` | `/api/build-jobs/:id/retry` | Retry authorized failed job |
| `GET` | `/api/businesses/:id/audit` | Recent edits; optional MVP UI |

## 6.2 Public read-only storefront endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/public/v1/stores/:slug` | Public business name, theme, contact metadata, revision |
| `GET` | `/public/v1/stores/:slug/products` | Paginated active product summaries; stock and image URLs |
| `GET` | `/public/v1/stores/:slug/products/:productSlug` | Public product details |

- CORS: allow exact deployed storefront origins, or use cache-safe public endpoints with sane protections; do not expose write credentials.
- CDN/cache: short TTL or revision-key invalidation. For hackathon, `Cache-Control: no-store` on catalog reads is acceptable to guarantee immediate demo update.
- Images should use public safe asset URLs or signed URLs with long-enough lifetime; never publish secret upload links.
- Catalog data should not expose merchant private email if the owner hasn't opted to publish it; alternatively offer a contact form with spam protection.

## 6.3 Typed tool contracts for ElevenLabs

Use only verified ElevenLabs-supported tool wiring; equivalent names are local tool IDs. Each tool MUST return structured result (`ok`, `data`, `error_code`, `spoken_summary`) and not just conversational text.

**Client-side tools** (browser UI controls):

```ts
capture_product_photo({
  call_id: string,
  product_draft_id: string,
  view: 'front' | 'side' | 'back' | 'detail' | 'other',
  reason?: string
}): Promise<{ok:boolean;capture_id?:string;thumbnail_url?:string;error_code?:string}>;

show_product_preview({product_draft_id:string}): Promise<{ok:boolean}>;
show_confirmation({kind:'publish'|'catalog_change', proposal_id:string}): Promise<{ok:boolean}>;
set_active_product({product_draft_id:string}): Promise<{ok:boolean}>;
```

The capture tool should capture a still locally, upload it to server storage, and return the server-confirmed capture ID. Agent should only claim capture success after this response.

**Server-side tools** (protected mutations/query):

```ts
upsert_business_brief({call_id:string, changes:BusinessBriefPatch}): ToolResult;
create_product_draft({call_id:string, proposed_title?:string}): ToolResult;
record_product_details({call_id:string, product_draft_id:string, fields:ProductDraftPatch}): ToolResult;
get_catalog_summary({business_id:string}): ToolResult;
resolve_product_reference({business_id:string, phrase:string}): ToolResult;
preview_catalog_changes({business_id:string, changes:CatalogChange[]}): ToolResult;
apply_confirmed_catalog_changes({proposal_id:string, confirmation_token:string}): ToolResult;
request_storefront_build({business_id:string, approved_spec_id:string}): ToolResult;
get_build_status({build_job_id:string}): ToolResult;
```

Do not give the model a raw arbitrary SQL tool or an unrestricted site deletion/publishing tool. Authorization must not depend on model statements.

## 6.4 Canonical catalog change shape

```ts
type CatalogChange =
 | {type:'set_price'; product_id:string; new_price_minor:number; currency_code:string}
 | {type:'set_quantity'; product_id:string; new_quantity:number}
 | {type:'adjust_quantity'; product_id:string; delta:number}
 | {type:'set_status'; product_id:string; status:'active'|'archived'}
 | {type:'update_copy'; product_id:string; title?:string; description?:string}
 | {type:'reorder'; product_id:string; new_sort_order:number};

type ProposedChangeSet = {
  id:string; business_id:string; call_id:string;
  expected_catalog_revision:number;
  changes:CatalogChange[];
  human_readable_summary:string;
  expires_at:string;
};
```

Two-step action: `preview` then `apply` only after confirmed approval and revision check. Idempotency key for apply. If underlying catalog revision changed between preview and apply, re-resolve and re-confirm.

### Quantity semantics
- “**Sold out**” → `set_quantity(0)` after confirmation.
- “**Sold one**” → `adjust_quantity(-1)` only if specific product and starting count known; otherwise clarify.
- “**Have six left**” → `set_quantity(6)`.
- “**Got six more**” → `adjust_quantity(+6)`.
- “**The blue one**” when two products match → ask which one, present thumbnails.
- Never permit negative inventory. Avoid implying a direct on-site order was fulfilled when the site is only contact-to-buy.

---

# 7. Voice/video capture and multimodal reasoning

## 7.1 Browser media
- Use `navigator.mediaDevices.getUserMedia` with explicit permissions, `facingMode:'environment'` on mobile when available; graceful fallback and camera-switch control.
- Maintain audio conversation independent of camera stream. Video-off must stop camera track, remove preview, and stop captures, but **not** terminate audio.
- Capture still frame using hidden canvas / ImageCapture when supported; prefer 720–1080 px longest dimension or native safe quality; compress within reasonable upload limits.
- Don't stream full video to your model in MVP. Capture on agent request or user button; upload selected still and feed resulting observations into session context.
- Capture must carry product-draft ID and `captured_at`; UI should display thumbnail and source view; allow retake/choose hero image.
- Handle denied permissions with clear message and upload fallback. Never assume camera access.

## 7.2 Product capture state machine

```text
NO_PRODUCT
  -> DRAFT_CREATED
  -> AWAITING_PHOTO
  -> PHOTO_UPLOADING
  -> PHOTO_PROCESSING
  -> DETAILS_INCOMPLETE
  -> DETAILS_CONFIRMED
  -> READY_TO_PUBLISH
```

Image enhancement is a parallel secondary state; do **not** block core listing creation waiting for enhancement. Photo analysis may finish after conversation has moved to next item: look up draft ID from capture metadata, never attach by recency.

## 7.3 Extraction fields and confidence
For each saved capture, vision outputs structured observations of **visible** features only: main object type, color, pattern, shape, visible labels, condition cues, ambiguity notes, photo quality, suggested alt text. It must not infer a price, quantity in stock, material certification, provenance, or product claims without explicit owner evidence.

Example result:
```json
{
  "capture_id":"uuid",
  "product_draft_id":"uuid",
  "observations":{
    "object_type":"mug",
    "visible_colors":["blue"],
    "distinguishing_features":["loop handle","speckled glaze"],
    "text_detected":[],
    "quality":{"blur":"low","lighting":"acceptable","framing":"good"},
    "ambiguities":["material cannot be confirmed visually"]
  }
}
```

Owner speech is the authority for price, available quantity, shipping terms, and seller-specific product description. Vision provides observations and clarifying questions.

## 7.4 Better images without misrepresentation
- First do reliable **crop, background cleanup, exposure/white balance and simple consistency**. For product generation/editing, preserve exact item geometry, design, logos, text, markings, defects, and color.
- Never replace an actual used/vintage product image with a substantially altered “idealized” object. Store both original and processed output, let owner approve enhanced photo. Quality-gate generated results: if distorted, inconsistent, or unavailable, fall back to original.
- If a manufacturer logo or label appears, preserve it faithfully rather than hallucinating new text.
- Listing should identify the actual item. Generative lifestyle imagery must not substitute for clear authentic listing photos.
- The public page displays selected image URL, retaining original in private catalog for rollback.

## 7.5 Spoken information extraction
Maintain a structured working memory separate from transcript; merge per-turn facts by source and timestamp. Suggested fields:

```ts
type BusinessBrief = {
  name?:string; description?:string; tone?:string;
  primary_color?:string; secondary_color?:string;
  preferred_layout?:string; contact_email?:string;
  fulfillment?:'pickup'|'delivery'|'both'|'unspecified';
};
type ProductDraftPatch = {
  title?:string; description?:string;
  price_minor?:number; currency_code?:string;
  quantity_on_hand?:number; inventory_tracked?:boolean;
  attributes?:Record<string,string>;
};
```

A draft field should record `source` (`owner_voice|owner_ui|vision_inferred`), `confidence`, `updated_at`, and `explicitly_confirmed` to prevent a visual guess overwriting the owner’s statement.

---

# 8. Replit generation, publication, and ongoing updates

## 8.1 Required behavior
- Build one responsive storefront that renders real-time product data from your backend's read-only public API.
- Do not hardcode demo inventory in generated app source or in a generated JSON file that becomes authoritative.
- Store should support product grid/detail, image display, prices (proper currency formatting), sold-out labels, merchant story and contact CTA.
- Maintain stable public URL after normal catalog updates; do not rebuild for price/quantity changes.
- Rebuild/update generated site only for structural/design/feature changes, after owner approval.

## 8.2 Build job lifecycle

```text
queued → preparing → creating → building → publishing → verifying → ready
                    ↘ failed (safe error + retryable classification)
```

**Important:** Replit's published-status method is not necessarily a build-status method. Discover actual MCP tools for build status. If no reliable readiness event exists, implement bounded polling for observable output, with honest timeout/failure handling; never assume prompt accepted = app built.

`ready` requires all of:
1. Replit reports a published URL or equivalent verified deployment result.
2. Anonymous HTTP GET returns valid page, not auth screen or error.
3. Store name and expected business identity render.
4. Product API responds with expected IDs and current catalog revision.
5. No obvious broken public image links, preferably smoke test in browser.

Do not send ready email before checks complete.

## 8.3 Minimal build specification sent to Replit

```text
Create a mobile-first, attractive production-style storefront for <business_name>.
Brand voice: <description/tone>.
Style: <palette/layout/typography choices>.

IMPORTANT DATA CONTRACT:
Products are NOT hardcoded. Fetch business information from
GET <PUBLIC_API_BASE>/public/v1/stores/<slug>
and products from
GET <PUBLIC_API_BASE>/public/v1/stores/<slug>/products.
Render the product IDs, titles, descriptions, selected image URLs, price_minor
with currency_code, quantity_on_hand, inventory_tracked, status, and availability.
When quantity_on_hand=0 and inventory_tracked=true, show Sold Out and disable inquiry
for that item or indicate unavailable.

Pages: homepage, product listing, simple product detail.
Primary purchase action: contact the owner to inquire; NO fabricated checkout.
Build responsive, accessible, fast-loading UI, descriptive alt text and error states.
Use public read-only API only. No merchant write credentials in client code.
Return app identifier, build state, and publication URL when actually available.
```

All Replit-specific calls should use exact current tool names and arguments from official docs/tool discovery, not assumed identifiers in an LLM prompt. Log correlation IDs and tool output safely.

## 8.4 Catalog API availability
- Keep API online separately from generated storefront (backend may itself be hosted anywhere appropriate).
- Use a stable `PUBLIC_API_BASE` host, HTTPS, tested DNS/CORS; do not put localhost URLs into generated site.
- If demo storefront is Replit-hosted, test network access from published frontend to the backend and browser CORS policies.
- If static generation is unavoidable, use per-request server rendering/proxy API or a fetch client that loads live catalog rather than compile-time products.

## 8.5 Concurrency and reconciliation
- Building a design revision may take time while stock changes continue. Since products come from catalog at runtime, build snapshots must not overwrite catalog.
- One active structural rebuild per store at a time; queue later changes or collapse to latest approved design spec.
- Track `catalog_revision` and `storefront_revision` separately.
- On failed new build, retain last working published site, and allow retry.

---

# 9. Notifications and owner identity

## 9.1 Email requirements
Subject example: `Your <business name> storefront is live`.
Content: actual verified published URL, a secure owner management/call link, short catalog summary, and support/failure path.
- No URL until verified.
- Never put raw admin tokens in publicly shareable site links.
- Management link should route to authenticated login; if using magic links, short expiration and single use.
- Track email provider accepted/sent status distinctly from confirmed inbox delivery.
- User can always revisit job status in app; email failure must not strand the owner.

## 9.2 Authentication choices
**Best for MVP:** owner enters email and verifies magic link/OTP; uses same login for future calls. Use a demo owner account only if time requires and label it as demo.
- Every store management action checks owner access server-side.
- Public site cannot alter the catalog.
- If product photos include people or private addresses, obtain confirmation before publishing or remove/redact those elements.

## 9.3 Consent and retention
Explain before call: microphone/camera permissions, whether transcript is stored, what selected images are uploaded, how content will be used for site generation, how to request deletion. Camera-off means no new captures. Do not record full video by default. Provide draft deletion/undo. Never publish sensitive or third-party private information accidentally shown in camera frames.

---

# 10. Safety, reliability, and quality

## 10.1 Owner approval gates
Require explicit approval for:
- Publicly publishing a new site and its contact information.
- Publishing a product, price, and inventory amount.
- Applying a bulk set of inventory/price changes (summarize changes in one confirmation).
- Substantial redesigns and features.
- Use of AI-enhanced product photos if materially edited.

## 10.2 Ambiguity and error handling
| Scenario | Expected response |
|---|---|
| Camera blocked / unavailable | Offer photo upload; continue audio call |
| ElevenLabs disconnected | Reconnect button, preserve draft call state |
| Photo upload fails | Keep local preview where possible; retry, do not claim saved |
| Image analysis slow | Continue conversation; draft remains pending; don't misassign |
| Multiple similar products | Show thumbnails/titles, ask precise disambiguation |
| Price missing | Ask for exact price; don't infer from appearance |
| Quantity unknown | Explicitly mark untracked or ask; don't invent `1` |
| “Sold it” ambiguous | Ask if one unit sold or item is fully sold out |
| Price suggestions | Label as estimates; merchant chooses actual price |
| Replit auth/build/publish fails | Clear status and retry; never send bogus URL |
| Email fails | Show verified link in authenticated UI; retry email |
| Stale edit or race | Revision conflict, re-read state, re-confirm if changed |
| Duplicate webhook/tool call | Idempotency key avoids duplicate products/edits |
| Public storefront offline | Track failure; show last healthy deployment or honest status |

## 10.3 Web/security controls
- No ElevenLabs private keys, Replit OAuth tokens, DB service keys, image provider keys, or email keys exposed in browser or generated storefront.
- Validate ElevenLabs webhooks with the provider's documented signature method; do not trust unverified callbacks.
- Require strict server-side owner authorization for management actions.
- Defend against prompt injection in image text, product labels, owner-visible descriptions and external webpages. They are *data*, not higher-priority instructions. Tool privileges constrained by authentication and typed schema.
- Rate-limit calls and expensive image generation; set media size limits and safe formats, prevent SVG/script injection in user content.
- Product descriptions and HTML-embedded fields sanitized and escaped.
- Store tokens encrypted at rest; redact secrets from logs and prompts.
- Contact mechanism should avoid leaking phone number or private address without explicit approval.

---

# 11. Stepwise implementation plan and work division

**Priority legend:** P0 = required demo; P1 = stretch. Parallelize only after shared contracts and API base chosen.

## Phase 0 — Prove hard dependencies first (P0)
- [ ] Inspect current official Replit MCP docs and exact integration flow; perform OAuth authentication.
- [ ] Execute minimal `create → build complete → publish → verify anonymous link` with a test storefront.
- [ ] Confirm deployed Replit page can fetch live catalog endpoint over HTTPS.
- [ ] Create ElevenLabs agent and verify a browser voice call; invoke one sample client tool and one authenticated server tool.
- [ ] Test email provider to the intended test recipient.
- [ ] If Replit integration blocked, pivot to transparent fallback before UI polish.

## Phase 1 — Data and catalog APIs (P0)
- [ ] Migrations for users, businesses, products, images, product drafts, calls, change events, build jobs, notifications.
- [ ] Owner/session auth and business-level authorization.
- [ ] Product CRUD, draft commit, read-only public API, increment store revision on each change.
- [ ] `preview_catalog_changes` + `apply` with idempotency and revision guard.
- [ ] Seed demo ceramics store and three products only for integration tests; real demo should create via call.

## Phase 2 — Browser call and product capture (P0)
- [ ] Responsive call view and media controls.
- [ ] ElevenLabs voice session with concise system prompt + typed tool bridge.
- [ ] Local still capture → signed upload → storage → thumbnail.
- [ ] Product draft card with ID-bound captures, required-field indicators and confirmation.
- [ ] Vision extraction pipeline and safe owner-correction loop.
- [ ] All typed tool results reflected accurately in spoken responses.

## Phase 3 — Storefront build + email (P0)
- [ ] Generate spec from owner-confirmed business profile and approved products.
- [ ] Queue Replit build with live catalog contract.
- [ ] Track actual build, publish, verify results; persist public URL.
- [ ] Trigger real email only after verified publish; include authenticated status page as fallback.
- [ ] Smoke test published site with 3 items, pictures, real prices and availability.

## Phase 4 — Returning call and live updates (P0)
- [ ] Load existing business and catalog by authenticated owner.
- [ ] Camera optional/off, audio still works.
- [ ] Recognize product references from current catalog; disambiguation.
- [ ] Preview proposed edits, require approval, apply, audit.
- [ ] Confirm published site updates at same URL after reload (no rebuild).

## Phase 5 — Polish / stretch (P1)
- [ ] Enhanced image variants with side-by-side original preview and owner approval.
- [ ] Add product from second call.
- [ ] Styling/design changes via Replit update job.
- [ ] Owner-friendly suggested pricing based on supplied data.
- [ ] Loading, error, empty states; accessibility and performance.

## Suggested multi-agent ownership
- **Agent A — Frontend/Call:** landing, responsive media controls, frame capture UI, ElevenLabs client hookup, previews.
- **Agent B — Backend/Catalog:** DB schema, owner auth, draft/product APIs, mutation-preview/apply, public read API.
- **Agent C — AI/Media:** ElevenLabs instructions/tool schemas, vision extraction, image enhancement and attachment safety.
- **Agent D — Replit/Jobs:** MCP auth/discovery, build orchestrator/status, publication validation, email job.
- **Agent E — Integration/QA:** shared types, E2E tests, seeded demo scenario, final live rehearsal, observability.

Avoid five agents editing shared config/schema files simultaneously. Agent B owns types/DB, D owns build orchestration, A owns call UI, C owns prompt/media, E integrates and reviews. Establish agreed API contracts first.

---

# 12. Detailed demo script (target ~2–3 minutes)

**Setup:** Three ceramics objects, phone camera, stable Wi-Fi, tested ElevenLabs voice, test email, publicly reachable backend/catalog and published site. Have fallback recordings/screenshots only as explicitly labeled backup; don't pretend recording is live.

**0:00–0:20 — Problem and call start**
“Small businesses don’t need a complicated site builder. They need to show what they sell. We let them call their website into existence.” Tap **Start my store**, allow mic/camera.

**0:20–1:05 — Capture products and business style**
Owner: “I run a ceramics shop. Warm, cream and green style.” Hold up blue mug: “This is my speckled blue mug, $24, four in stock.” Agent captures it and preview appears. Quickly add white bowl and tall vase (prepared but captured genuinely if possible).

**1:05–1:35 — Confirm → Replit → publish**
Agent reads concise summary; owner approves. Show genuine build/publish state and link. If the Replit generation job is too slow, have a *previously generated* store from an earlier real run ready for the demo, transparently noting that the build was pre-run; still perform voice update live on that same store.

**1:35–2:00 — Public URL**
Open URL in incognito; show catalog and image quality. Highlight “Sold out” mechanism and contact-to-buy, no fake checkout.

**2:00–2:30 — Return call, camera off**
Owner: “The tall vase sold out and the blue mug is now $20.” Agent resolves and confirms. Apply. Refresh same URL; vase marked sold out, mug now $20.

**2:30–2:45 — One-line close**
“The storefront isn't a one-time generated page. It's a business tool the owner can keep running with a conversation.”

## Backup demo hierarchy
1. Best: fully live create + publish + update.
2. Acceptable with disclosure: prebuilt Replit site from a real earlier run, live voice-driven catalog update and real URL.
3. Honest integration-block fallback: working voice-driven storefront template and a displayed Replit handoff, explicitly explain Replit API limitation.

---

# 13. Testing plan

## 13.1 Unit and contract tests
- Parsing/validation: `$24.00` → `2400`, `0` inventory valid, negative amount invalid.
- Quantity language: `sold one`, `sold out`, `six left`, `six more` map correctly.
- Product resolution: two blue mugs causes disambiguation, not arbitrary selection.
- Revision guard rejects stale edits; repeated idempotency key does not double-apply.
- Capture completion maps to explicitly attached draft ID, not active UI item.
- Public catalog excludes draft/archived items and private owner data.

## 13.2 Integration tests
- Client tool `capture_product_photo` returns capture ID and backend stores original.
- Vision result attaches to the correct draft even when a second product becomes active.
- Agent initiates proposed change but server refuses apply without owner confirmation.
- Build job state not marked ready without verified anonymous URL and expected store/product content.
- Email job not triggered for failed/unverified publication.
- Public deployed frontend reads changed price/stock without rebuild.
- Expired session or wrong owner cannot change another business's products.

## 13.3 End-to-end scenarios
**E2E A — Fresh store:** owner on mobile → live voice call → 3 photographed products → confirm → build job ready → received/visible link → public site correct.

**E2E B — Existing store:** owner logs in → camera off → “vase sold out, blue mug $20” → exact preview → approve → success → same site URL shows values.

**E2E C — Ambiguity:** two products called “blue mug”; agent asks which image/variant before editing.

**E2E D — Failure:** Replit publish fails; status clearly fails, email has no fake URL, retry works.

**E2E E — Permissions:** deny camera; mic call still works; upload alternative visible.

## 13.4 Performance budgets (aspirational)
- Mic/call start visibly responsive; no blank screen while connecting.
- Capture thumbnail appears immediately; server confirmation asynchronous and labeled pending.
- Catalog mutation/refresh visibly completed in seconds under normal network conditions.
- Replit builds may take materially longer; display real status without fake timer/countdown.

---

# 14. Design copy and conversation prompts

## Landing
**Headline:** “Your storefront starts with a conversation.”
**Subhead:** “Show your products, tell us about your business, and get a website you can update with another call.”
**CTA:** “Start a call”
**Supporting text:** “Camera optional. We'll confirm your listings before publishing.”

## Agent opening
“Hi! I can help build a storefront for your business. What do you sell, and what should customers know about you?”

## Product capture
“Let's add your first product. Could you show it to the camera? What's it called, how much is it, and how many do you have?”

## Photo correction
“I captured that image, but the label is a little blurry. Want to try another angle or keep this one?”

## Price suggestion
“I can suggest a starting price if you tell me roughly what it costs to make and how much time goes into it. The final price is always your choice.”

## Pre-publication approval
“I have three products ready: [titles, prices, stock]. Your site will use [style] and display [approved contact]. Should I publish this information publicly?”

## Return-call greeting
“Welcome back to [store name]. I can update products and stock, add a new item if you turn on your camera, or help revise the site. What would you like to change?”

## Update readback
“Here's what I'll change: tall vase, one remaining → sold out; blue mug, $24 → $20. Should I apply both changes?”

## Build-in-progress
“The details are saved. I'm preparing the storefront. I'll show you the verified link here, and email it when it's live.”

## Failed build
“I saved your store details, but the website wasn't published successfully. Nothing is live yet. You can retry from this status page.”

---

# 15. Open questions and chosen defaults

| Question | Default for today's MVP | Later alternative |
|---|---|---|
| Checkout or contact-to-buy? | **Contact-to-buy** only | Payments + verified order events |
| Phone-native or browser? | **Responsive browser call** | Native apps / telephony |
| Continuous video understanding? | **Selected still frames** | Continuous multimodal streaming |
| Inventory source? | **Owner statements, explicit confirmation** | POS integration and order sync |
| Image generation? | **Non-destructive enhancement, original fallback** | More creative branded assets with approval |
| Pricing suggestion? | **Owner-cost-based, optional** | Sourced comparable items with dates |
| Replit role? | **Initial site and design/feature code** | Deeper workflows and plugins |
| Common catalog edits? | **Direct backend DB update** | Still direct, with richer workflows |
| Auth? | **Verified owner email / demo login** | Full multi-merchant auth |
| Multiple locations/multiple users? | **No** | Roles and inventory locations |
| Fulfillment? | **Pickup/contact inquiry** | Shipping and transactions |
| Email timing? | **Only after verified public URL** | SMS/push in addition |
| New store or update existing? | **Persistent store ID from account** | Multi-store management |

---

# 16. Definition of done and agent instruction block

A build is **done** only if:

- [ ] A business owner can speak with the ElevenLabs agent through the browser with optional camera.
- [ ] At least three products can be captured from real camera images and confirmed with correct price/quantity.
- [ ] Data is persisted under stable business/product IDs, independent of call lifetime and generated UI source.
- [ ] A functional publicly accessible storefront is published and loads these products, with status/price/images correct.
- [ ] Publishing status is accurate and a real email containing its URL is sent only after verification (or failure clearly reported).
- [ ] A subsequent **camera-off** conversation can update an existing product's price and stock.
- [ ] **The same published URL** reflects those catalog changes without a rebuild.
- [ ] Camera denial, ambiguous product reference, and failed publishing have graceful outcomes.
- [ ] Secrets are server-only and owner writes are authorized and confirmed.

### Paste into coding-agent task instructions

> Implement **Call-to-Storefront** according to this document. Prioritize P0 only until the full create → publish → voice-update demo succeeds. Begin by verifying actual Replit MCP OAuth and build/publish capabilities, ElevenLabs client/server tool integration, and the live catalog API deployment. Use a structured canonical catalog and typed confirmation-gated mutations. Replit-generated storefront must read live public catalog data; never hardcode price/stock as the source of truth. Distinguish tool success from assumptions and report missing integrations transparently. Ship a polished, responsive video-call UI with camera optional, image capture linked to product drafts, ElevenLabs conversation, published-link verification, real email, and a second camera-off call updating the same storefront. Write tests for product association, update ambiguity, idempotency, permissions, and public refresh. If time is limited, reduce feature count rather than faking the complete flow. Maintain a short list of verified working features, test URLs, setup steps, and remaining blockers in README.

---

# 17. Documentation references to verify during implementation

These links identify official provider documentation entry points. Exact SDK functions, permissions, versions, and MCP tool schemas must be verified at implementation time; this document intentionally does **not** invent provider-specific request payloads.

- Replit MCP Server: https://docs.replit.com/platforms/mcp-server
- Replit developer documentation: https://docs.replit.com/
- ElevenLabs Agents documentation: https://elevenlabs.io/docs/eleven-agents
- ElevenLabs client tools: https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools
- ElevenLabs post-call webhooks: https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks
- ElevenLabs developer documentation: https://elevenlabs.io/docs

**Last word:** The product is **not** “AI makes a pretty website from a prompt.” Its defensible interaction is: *a small business owner demonstrates and describes real inventory and business rules through a call; their storefront becomes live software that stays editable through future calls.*
