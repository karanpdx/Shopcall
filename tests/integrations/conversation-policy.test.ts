import test from "node:test";
import assert from "node:assert/strict";
import { catalogChange, productFields } from "../../src/contracts/catalog";
import { CLIENT_TOOL_NAMES } from "../../src/contracts/integrations";
import {
  EXAMPLE_CALL_SCRIPTS,
  INTAKE_DESIGN_TARGET_SECONDS,
  MERCHANT_CONVERSATION_RULES,
  buildMerchantConversationPolicy,
  composeChangeReview,
  composeFollowUpQuestion,
  composePublishReview,
  composeStoreQuestion,
  estimateScriptSeconds,
  formatPrice,
  getMissingCriticalFields,
  getMissingStoreFacts,
  planSaleUpdate,
  type CallScript,
  type ImageFact,
  type InventoryFact,
  type MissingFieldsContext,
  type ProductDraftFacts,
  type Sourced,
  type StoreFacts,
} from "../../src/integrations/elevenlabs/conversation-policy";

const voice = <T>(value: T): Sourced<T> => ({ value, source: "owner_voice" });
const vision = <T>(value: T): Sourced<T> => ({ value, source: "vision_inferred" });
const tracked = (n: number): InventoryFact => ({ tracked: true, quantityOnHand: n });
const photo: ImageFact = { kind: "capture", captureId: "cap-1" };
const ctx = { defaultCurrencyCode: "USD", cameraEnabled: true };
const fields = (draft: ProductDraftFacts, c: MissingFieldsContext = ctx) => getMissingCriticalFields(draft, c).map(m => m.field);
const PID = "f1fa84f0-c846-48ba-9cad-7bf073e906fb";

// --- missing critical fields ------------------------------------------------

test("empty draft needs name, price, stock and photo, in ask order", () => {
  assert.deepEqual(fields({}), ["title", "price", "stock", "image"]);
});

test("facts volunteered in one sentence are never re-asked", () => {
  const draft = { title: voice("Blue mug"), priceMinor: voice(2400), inventory: voice(tracked(4)), image: photo };
  assert.deepEqual(getMissingCriticalFields(draft, ctx), []);
  assert.equal(composeFollowUpQuestion(draft, []), null);
});

test("only the missing parts are asked, together in one question", () => {
  const draft = { title: voice("Tall vase"), image: photo };
  const missing = getMissingCriticalFields(draft, ctx);
  assert.deepEqual(missing.map(m => m.field), ["price", "stock"]);
  const q = composeFollowUpQuestion(draft, missing)!;
  assert.match(q, /how much/i);
  assert.match(q, /how many/i);
  assert.doesNotMatch(q, /called/i);
  assert.equal((q.match(/\?/g) ?? []).length, 1, "one question, not several");
});

test("vision never supplies price or stock, and a vision title is only a guess", () => {
  const draft: ProductDraftFacts = {
    title: vision("Blue mug"),
    priceMinor: vision(2400),
    inventory: vision(tracked(1)),
    image: photo,
  };
  const missing = getMissingCriticalFields(draft, ctx);
  assert.deepEqual(missing, [
    { field: "title", reason: "unconfirmed_guess" },
    { field: "price", reason: "missing" },
    { field: "stock", reason: "missing" },
  ]);
  assert.match(composeFollowUpQuestion(draft, missing)!, /^Is this the Blue mug, how much is it, and how many/);
});

test("unknown stock needs a count or an explicit untracked choice, matching the catalog contract", () => {
  const base = { title: voice("Bowl"), priceMinor: voice(1800), image: photo };
  assert.deepEqual(fields(base), ["stock"]);
  assert.match(composeFollowUpQuestion(base, getMissingCriticalFields(base, ctx))!, /skip tracking stock/);
  for (const inv of [tracked(0), tracked(6), { tracked: false } as const]) {
    assert.deepEqual(fields({ ...base, inventory: voice(inv) }), []);
    // Every complete draft maps to a contract-valid product.
    const parsed = productFields.safeParse({
      title: "Bowl", description: "", priceMinor: 1800, currencyCode: "USD",
      inventoryTracked: inv.tracked, quantityOnHand: inv.tracked ? inv.quantityOnHand : null,
    });
    assert.equal(parsed.success, true);
  }
  assert.deepEqual(getMissingCriticalFields({ ...base, inventory: voice(tracked(-1)) }, ctx), [{ field: "stock", reason: "invalid" }]);
  assert.deepEqual(getMissingCriticalFields({ ...base, inventory: voice(tracked(1.5)) }, ctx), [{ field: "stock", reason: "invalid" }]);
});

test("price must be integer minor units with a known currency", () => {
  const base = { title: voice("Mug"), inventory: voice(tracked(1)), image: photo };
  assert.deepEqual(getMissingCriticalFields({ ...base, priceMinor: voice(24.5) }, ctx), [{ field: "price", reason: "invalid" }]);
  assert.deepEqual(getMissingCriticalFields({ ...base, priceMinor: voice(2400) }, { cameraEnabled: true }), [
    { field: "price", reason: "currency_unknown" },
  ]);
  assert.deepEqual(getMissingCriticalFields({ ...base, priceMinor: voice(2400), currencyCode: voice("EUR") }, { cameraEnabled: true }), []);
  assert.deepEqual(getMissingCriticalFields({ ...base, priceMinor: voice(2400), currencyCode: voice("eur") }, { cameraEnabled: true }), [
    { field: "price", reason: "invalid" },
  ]);
});

test("camera off: no capture request, offer camera or no-photo choice", () => {
  const draft = { title: voice("Mug"), priceMinor: voice(2400), inventory: voice(tracked(2)) };
  const missing = getMissingCriticalFields(draft, { ...ctx, cameraEnabled: false });
  assert.deepEqual(missing, [{ field: "image", reason: "camera_off" }]);
  assert.match(composeFollowUpQuestion(draft, missing)!, /without one/);
  assert.deepEqual(fields({ ...draft, image: { kind: "none_chosen" } }, { ...ctx, cameraEnabled: false }), []);
  assert.deepEqual(fields(draft, { ...ctx, cameraEnabled: false, requireImage: false }), []);
});

// --- store facts -----------------------------------------------------------

test("public contact consent is never inferred; optional brand fields never block", () => {
  const store: StoreFacts = { businessName: voice("Clay & Kiln"), contactEmail: voice("a@b.example") };
  assert.deepEqual(getMissingStoreFacts(store), ["public_contact_consent"]);
  assert.deepEqual(getMissingStoreFacts({ ...store, publicContactConsent: vision(true) }), ["public_contact_consent"]);
  assert.deepEqual(getMissingStoreFacts({ ...store, publicContactConsent: voice(false) }), ["public_contact_consent"]);
  assert.deepEqual(getMissingStoreFacts({ ...store, publicContactConsent: voice(true) }), []);
  assert.match(composeStoreQuestion(["contact_email", "public_contact_consent"])!, /email.*publicly/);
  assert.equal(composeStoreQuestion([]), null);
});

// --- sold statements --------------------------------------------------------

const mug = (inv: InventoryFact) => ({ id: PID, title: "blue mug", inventory: inv });

test("ambiguous 'sold it' asks one-or-sold-out instead of assuming", () => {
  const plan = planSaleUpdate({ productId: PID, units: "unspecified" }, mug(tracked(4)));
  assert.equal(plan.kind, "clarify");
  assert.match(plan.kind === "clarify" ? plan.question : "", /sell one blue mug, or is it sold out/);
});

test("'sold it' with exactly one left is not ambiguous", () => {
  const plan = planSaleUpdate({ productId: PID, units: "unspecified" }, mug(tracked(1)));
  assert.equal(plan.kind, "change");
  if (plan.kind === "change") assert.deepEqual(plan.after, tracked(0));
});

test("sold out, sold N, oversell and untracked map to contract-valid changes or clarifications", () => {
  const out = planSaleUpdate({ productId: PID, units: "all" }, mug(tracked(4)));
  assert.equal(out.kind, "change");
  if (out.kind === "change") {
    assert.deepEqual(out.change, { type: "set_quantity", productId: PID, newQuantity: 0 });
    assert.equal(catalogChange.safeParse(out.change).success, true);
  }
  const two = planSaleUpdate({ productId: PID, units: 2 }, mug(tracked(4)));
  assert.equal(two.kind, "change");
  if (two.kind === "change") {
    assert.deepEqual(two.change, { type: "adjust_quantity", productId: PID, delta: -2 });
    assert.equal(catalogChange.safeParse(two.change).success, true);
  }
  assert.equal(planSaleUpdate({ productId: PID, units: 5 }, mug(tracked(4))).kind, "clarify", "never negative stock");
  assert.equal(planSaleUpdate({ productId: PID, units: 0 }, mug(tracked(4))).kind, "clarify");
  assert.equal(planSaleUpdate({ productId: PID, units: "unspecified" }, mug({ tracked: false })).kind, "clarify");
  assert.equal(planSaleUpdate({ productId: PID, units: 1 }, mug({ tracked: false })).kind, "clarify");
  assert.equal(planSaleUpdate({ productId: PID, units: "all" }, mug({ tracked: false })).kind, "change");
  assert.equal(planSaleUpdate({ productId: PID, units: "all" }, mug(tracked(0))).kind, "no_change");
});

// --- reviews ----------------------------------------------------------------

test("publish review refuses while any critical fact is missing", () => {
  const complete = { title: voice("Mug"), priceMinor: voice(2400), inventory: voice(tracked(2)), image: photo };
  const store = { businessName: voice("Shop"), contactEmail: voice("a@b.example"), publicContactConsent: voice(true) };
  const missingStock = composePublishReview({ defaultCurrencyCode: "USD", store, products: [{ facts: complete }, { facts: { ...complete, inventory: undefined } }] });
  assert.equal(missingStock.ok, false);
  if (!missingStock.ok) assert.deepEqual(missingStock.missingProducts, [{ index: 1, missing: [{ field: "stock", reason: "missing" }] }]);
  assert.equal(composePublishReview({ defaultCurrencyCode: "USD", store: { ...store, publicContactConsent: undefined }, products: [{ facts: complete }] }).ok, false);
  assert.equal(composePublishReview({ defaultCurrencyCode: "USD", store, products: [] }).ok, false);
  const visionCurrency = composePublishReview({ defaultCurrencyCode: "USD", store, products: [{ facts: { ...complete, currencyCode: vision("EUR") } }] });
  assert.equal(visionCurrency.ok, true);
  if (visionCurrency.ok) assert.match(visionCurrency.text, /\$24/, "review must use the same owner-authoritative currency as the gate");
  const ok = composePublishReview({ defaultCurrencyCode: "USD", store, products: [{ facts: complete }] });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.match(ok.text, /Mug, \$24, 2 in stock.*a@b\.example.*tap Publish/);
});

test("several edits produce one combined confirmation", () => {
  const usd = (p: number, inv: InventoryFact) => ({ priceMinor: p, currencyCode: "USD", inventory: inv });
  const text = composeChangeReview([
    { title: "tall vase", before: usd(4500, tracked(1)), after: usd(4500, tracked(0)) },
    { title: "blue mug", before: usd(2400, tracked(4)), after: usd(2000, tracked(4)) },
  ]);
  assert.equal(text, "Here's what I'll change: tall vase, 1 left → sold out; blue mug, $24 → $20. If that's right, tap Confirm on screen to apply both changes.");
  assert.throws(() => composeChangeReview([]));
  assert.equal(formatPrice(1999, "USD"), "$19.99");
  assert.equal(formatPrice(500, "JPY"), "¥500");
});

// --- prompt policy ----------------------------------------------------------

test("policy prompt covers every rule and only references real client tools", () => {
  for (const mode of ["create", "update"] as const) {
    for (const cameraEnabled of [true, false]) {
      const prompt = buildMerchantConversationPolicy({ mode, cameraEnabled, storeName: "Clay & Kiln" });
      for (const rule of MERCHANT_CONVERSATION_RULES) assert.ok(prompt.includes(rule.text), rule.id);
      const referenced = [...prompt.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map(m => m[0]);
      for (const name of referenced) assert.ok((CLIENT_TOOL_NAMES as readonly string[]).includes(name), `unknown tool ${name}`);
      assert.equal(prompt.includes("capture_product_photo"), cameraEnabled);
      assert.doesNotMatch(prompt, /apply_confirmed|request_storefront_build|publish_app/);
    }
  }
  const ids = MERCHANT_CONVERSATION_RULES.map(r => r.id);
  for (const id of ["extract", "bundle", "only-missing", "optional", "no-infer", "stock", "sold", "one-review", "approval"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(buildMerchantConversationPolicy({ mode: "create", cameraEnabled: true }), buildMerchantConversationPolicy({ mode: "create", cameraEnabled: true }));
});

// --- example call scripts -----------------------------------------------------

function replay(script: CallScript) {
  const drafts: Record<string, ProductDraftFacts> = {};
  let store: StoreFacts = {};
  const c = { defaultCurrencyCode: script.defaultCurrencyCode, cameraEnabled: script.cameraEnabled };
  let reviews = 0;
  let questions = 0;
  for (const turn of script.turns) {
    if (turn.speaker === "merchant") {
      for (const [k, f] of Object.entries(turn.productFacts ?? {})) drafts[k] = { ...drafts[k], ...f };
      for (const [k, img] of Object.entries(turn.images ?? {})) drafts[k] = { ...drafts[k], image: img };
      store = { ...store, ...turn.storeFacts };
      continue;
    }
    if (turn.kind !== "ack") questions++;
    if (turn.kind === "review") reviews++;
    if (turn.asks) {
      const missing = getMissingCriticalFields(drafts[turn.asks.draft] ?? {}, c).map(m => m.field);
      for (const f of turn.asks.fields) assert.ok(missing.includes(f), `${script.id}: re-asked ${turn.asks.draft}.${f}`);
    }
    for (const f of turn.asksStore ?? []) assert.ok(getMissingStoreFacts(store).includes(f), `${script.id}: re-asked store ${f}`);
    if (!script.cameraEnabled) assert.notEqual(turn.kind, "capture");
  }
  return { drafts, store, reviews, questions };
}

test("example scripts exist for first store, camera-off updates and ambiguous 'sold it'", () => {
  assert.deepEqual(EXAMPLE_CALL_SCRIPTS.map(s => s.id), ["first-store", "camera-off-updates", "ambiguous-sold-it"]);
  for (const s of EXAMPLE_CALL_SCRIPTS) {
    const { reviews } = replay(s);
    assert.equal(reviews, 1, `${s.id}: exactly one combined review`);
    const last = s.turns[s.turns.length - 1];
    assert.equal(last.speaker === "agent" ? last.kind : null, "review");
  }
});

test("first-store script never re-asks and reaches review with every critical fact", () => {
  const script = EXAMPLE_CALL_SCRIPTS.find(s => s.id === "first-store")!;
  const { drafts, store, questions } = replay(script);
  assert.equal(Object.keys(drafts).length, 3);
  for (const d of Object.values(drafts)) assert.deepEqual(getMissingCriticalFields(d, { defaultCurrencyCode: "USD", cameraEnabled: true }), []);
  assert.deepEqual(getMissingStoreFacts(store), []);
  assert.ok(questions <= 7, `too many agent prompts: ${questions}`);
  // Design target only: an estimate from word counts, not a measured call.
  assert.ok(estimateScriptSeconds(script) <= INTAKE_DESIGN_TARGET_SECONDS, `estimate ${estimateScriptSeconds(script)}s`);
});

test("camera-off script applies an explicit 'sold out' without extra questions", () => {
  const script = EXAMPLE_CALL_SCRIPTS.find(s => s.id === "camera-off-updates")!;
  const agentTurns = script.turns.filter(t => t.speaker === "agent");
  assert.deepEqual(agentTurns.map(t => t.kind), ["question", "review"]);
  assert.match(agentTurns[1].text, /Tall vase, not tracked → sold out; Speckled blue mug, \$24 → \$20; White bowl, 6 left → 9 left.*all three changes/);
});

test("ambiguous script's clarification is exactly the planner's question", () => {
  const script = EXAMPLE_CALL_SCRIPTS.find(s => s.id === "ambiguous-sold-it")!;
  const plan = planSaleUpdate({ productId: PID, units: "unspecified" }, { id: PID, title: "Speckled blue mug", inventory: tracked(4) });
  assert.equal(plan.kind, "clarify");
  const clarify = script.turns.find(t => t.speaker === "agent" && t.kind === "clarify")!;
  assert.equal(clarify.text, plan.kind === "clarify" ? plan.question : "");
  const one = planSaleUpdate({ productId: PID, units: 1 }, { id: PID, title: "Speckled blue mug", inventory: tracked(4) });
  assert.equal(one.kind, "change");
  if (one.kind === "change") assert.deepEqual(one.after, tracked(3));
  assert.match(script.turns[script.turns.length - 1].text, /4 left → 3 left.*this change/);
});
