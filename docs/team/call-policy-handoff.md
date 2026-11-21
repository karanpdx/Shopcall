# Handoff: merchant conversation policy (Person C)

Module: `src/integrations/elevenlabs/conversation-policy.ts`
Tests: `tests/integrations/conversation-policy.test.ts`

## Status

| Piece | State |
|---|---|
| Prompt policy text + rules | **Implemented, tested locally** (deterministic string tests) |
| Missing-critical-fields / store-facts helpers | **Implemented, tested locally** |
| Sale ("sold it") planner, combined review composers | **Implemented, tested locally** |
| Three example call scripts | **Fixtures only**, replayed by tests. No live call, no TTS |
| Wiring into the managed ElevenLabs agent | **Not done** (Codex) |
| Provider-verified / deployed | **No** |

The ~2-minute first-store intake is a **design target**. `estimateScriptSeconds` is a word-count estimate (first-store fixture: ~86 s), not a measurement and not a timeout.

Run tests explicitly (the `npm test` glob only covers `tests/*.test.ts`):

```sh
npx tsx --test tests/integrations/conversation-policy.test.ts
```

## Exact exports

Prompt policy
- `buildMerchantConversationPolicy(ctx: PolicyContext): string`: the system-prompt text for the managed agent. `PolicyContext = { mode: "create" | "update"; cameraEnabled: boolean; storeName?: string }`. Only references names in `CLIENT_TOOL_NAMES`; omits `capture_product_photo` when the camera is off.
- `MERCHANT_CONVERSATION_RULES: readonly PolicyRule[]`: the individual rules (`{ id, text }`). Ids: `goal`, `extract`, `bundle`, `only-missing`, `optional`, `no-infer`, `stock`, `sold`, `identity`, `one-review`, `approval`, `camera`, `style`.
- `INTAKE_DESIGN_TARGET_SECONDS = 120`: a pacing target only.
- Types: `PolicyContext`, `PolicyRule`, `ClientToolName`.

Fact model and missing-field helpers (pure)
- `getMissingCriticalFields(draft: ProductDraftFacts, ctx: MissingFieldsContext): MissingField[]`: returns `title | price | stock | image` in ask order, each with a reason (`missing | unconfirmed_guess | invalid | currency_unknown | camera_off`).
- `getMissingStoreFacts(store: StoreFacts): StoreField[]`: returns `business_name | contact_email | public_contact_consent`. Brand, story, style and shipping fields are never included.
- `isOwnerAuthoritative(source: FactSource): boolean`
- `resolveCurrencyCode(draft, defaultCurrencyCode?): string | undefined`: owner-sourced currency, else the store default. The gate and the publish review both use it.
- `CRITICAL_FIELD_ORDER`
- Types: `FactSource`, `Sourced<T>`, `InventoryFact`, `ImageFact`, `ProductDraftFacts`, `CriticalField`, `MissingReason`, `MissingField`, `MissingFieldsContext`, `StoreFacts`, `StoreField`.

Question and review composers (pure)
- `composeFollowUpQuestion(draft, missing): string | null`: one question covering every missing name, price and stock fact together. It handles the image step only when nothing else is missing.
- `composeStoreQuestion(missing: StoreField[]): string | null`: asks for the email and the public-display consent in one question when both are missing.
- `composePublishReview(input: PublishReviewInput): PublishReview`: one combined pre-publish readback. Returns `{ ok: false, missingProducts, missingStore }` while anything critical is missing.
- `composeChangeReview(lines: ChangeReviewLine[]): string`: one combined confirmation for all pending edits ("…apply both changes" or "…apply all three changes").
- `formatPrice(priceMinor, currencyCode)`, `formatStock(inventory)`
- Types: `PublishReviewInput`, `PublishReview`, `ChangeReviewLine`, `ReviewState`.

Sale planner (pure)
- `planSaleUpdate(statement: SaleStatement, product: ProductSnapshot): SalePlan`: returns `change` (a contract-valid `CatalogChange` with before/after), `clarify` (a question), or `no_change`.
- Types: `SaleStatement` (`units: number | "all" | "unspecified"`), `ProductSnapshot`, `SalePlan`.

Fixtures
- `EXAMPLE_CALL_SCRIPTS: readonly CallScript[]`: ids `first-store`, `camera-off-updates`, `ambiguous-sold-it`. Usable as few-shot examples.
- `estimateScriptSeconds(script)`
- Types: `CallScript`, `ScriptTurn`.

## Policy decisions encoded

- **Authority:** only `owner_voice`, `owner_ui` and `catalog` facts count. Vision can propose a title for the owner to confirm. It never supplies price, stock, consent or approval.
- **Stock:** a fact is complete only as `{ tracked: true, quantityOnHand: int ≥ 0 }` or an explicit `{ tracked: false }`. This matches the `inventoryTracked`/`quantityOnHand` refine in `src/contracts/catalog.ts`. Vague or unknown stock stays missing, and it never defaults to 1.
- **Currency:** when the store has a default currency, the agent never asks for one.
- **"Sold it":** with no count and more than one in stock, the agent asks whether one sold or the item is sold out. With exactly one left it proposes 0 without asking, because both readings give the same result. Overselling or a non-positive count leads to a clarifying question; stock never goes negative. "Sold out" on an untracked item proposes `set_quantity(0)`.
- **Consent:** a public contact needs an explicit owner yes. A "no" blocks the publish review, because contact-to-buy needs a contact path.
- **Approval:** review text tells the owner to tap Confirm/Publish on screen. The agent has no apply or publish tool, consistent with `CLIENT_TOOL_NAMES`.

## For Codex: wiring notes and open items

1. Pass `buildMerchantConversationPolicy({ mode, cameraEnabled, storeName })` as the agent's system prompt or prompt override. Camera state can change mid-call, so decide whether to re-issue the prompt or rely on the `camera` rule plus tool errors.
2. The draft and tool shapes in this module are local. Map B's draft and tool payloads into `ProductDraftFacts`, keeping each field's `source`. Do not mark model-extracted values as `owner_ui`.
3. **B to confirm:** whether `set_quantity` on an untracked product also sets `inventoryTracked = true`. `planSaleUpdate` assumes it does (after = tracked 0).
4. Changes to stock and price at the same time ("six more and now $20") are composed by the caller into one `ChangeReviewLine` per product. The planner covers sale statements only.
5. Spoken phrasing is English only and uses titles exactly as stored.
