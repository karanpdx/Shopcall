/**
 * Shopcall merchant-conversation policy.
 *
 * Pure, provider-agnostic module: no network, no TTS, no ElevenLabs SDK calls.
 * It exports (1) the system-prompt policy text for the managed voice agent and
 * (2) deterministic helpers the agent bridge / UI can use to decide what is
 * still missing, what single follow-up question to ask, how to plan a "sold"
 * statement, and how to phrase one combined review.
 *
 * Owner speech/UI is the only authority for price, stock, public-contact
 * consent and approval. Vision guesses never satisfy those facts.
 */
import { currency, moneyMinor, quantity, type CatalogChange } from "../../contracts/catalog";
import { CLIENT_TOOL_NAMES } from "../../contracts/integrations";

// ---------------------------------------------------------------------------
// Fact model
// ---------------------------------------------------------------------------

/** Where a fact came from. Only owner sources (and the existing approved catalog) are authoritative. */
export type FactSource = "owner_voice" | "owner_ui" | "catalog" | "vision_inferred";

export type Sourced<T> = { value: T; source: FactSource };

/** Mirrors the `inventoryTracked` / `quantityOnHand` rule in `src/contracts/catalog.ts`. */
export type InventoryFact = { tracked: true; quantityOnHand: number } | { tracked: false };

export type ImageFact = { kind: "capture"; captureId: string } | { kind: "none_chosen" };

/** Facts gathered so far for one product draft. Absent = not yet known. */
export type ProductDraftFacts = {
  title?: Sourced<string>;
  priceMinor?: Sourced<number>;
  currencyCode?: Sourced<string>;
  inventory?: Sourced<InventoryFact>;
  image?: ImageFact;
};

export type CriticalField = "title" | "price" | "stock" | "image";

export type MissingReason =
  /** Nothing usable recorded. */
  | "missing"
  /** Only a model/vision guess exists; owner must confirm or replace it. */
  | "unconfirmed_guess"
  /** A value exists but violates the catalog contract. */
  | "invalid"
  /** Price known but no currency and no store default. */
  | "currency_unknown"
  /** Image required, camera is off: owner must turn camera on or choose no image. */
  | "camera_off";

export type MissingField = { field: CriticalField; reason: MissingReason };

export type MissingFieldsContext = {
  /** Store default currency; when present the agent never asks for currency. */
  defaultCurrencyCode?: string;
  cameraEnabled: boolean;
  /** New listings need a photo or an explicit no-image choice. Defaults to true. */
  requireImage?: boolean;
};

/** Ask order: name, price and stock are collected together, image last. */
export const CRITICAL_FIELD_ORDER: readonly CriticalField[] = ["title", "price", "stock", "image"];

const OWNER_SOURCES: ReadonlySet<FactSource> = new Set(["owner_voice", "owner_ui", "catalog"]);

export function isOwnerAuthoritative(source: FactSource): boolean {
  return OWNER_SOURCES.has(source);
}

/**
 * Pure helper: which critical facts are still missing for a product draft.
 *
 * - Never re-asks: any valid owner-sourced fact is treated as answered.
 * - Never infers: vision-sourced price/stock are ignored entirely; a vision title
 *   is only a guess the owner must confirm.
 * - Unknown stock stays missing until the owner gives a count or explicitly
 *   chooses untracked inventory.
 */
export function getMissingCriticalFields(draft: ProductDraftFacts, ctx: MissingFieldsContext): MissingField[] {
  const missing: MissingField[] = [];

  // Title
  if (!draft.title) {
    missing.push({ field: "title", reason: "missing" });
  } else if (!isOwnerAuthoritative(draft.title.source)) {
    missing.push({ field: "title", reason: "unconfirmed_guess" });
  } else {
    const t = draft.title.value.trim();
    if (t.length < 1 || t.length > 160) missing.push({ field: "title", reason: "invalid" });
  }

  // Price (+ currency)
  const price = draft.priceMinor && isOwnerAuthoritative(draft.priceMinor.source) ? draft.priceMinor : undefined;
  if (!price) {
    missing.push({ field: "price", reason: "missing" });
  } else if (!moneyMinor.safeParse(price.value).success) {
    missing.push({ field: "price", reason: "invalid" });
  } else {
    const ownerCurrency =
      draft.currencyCode && isOwnerAuthoritative(draft.currencyCode.source) ? draft.currencyCode.value : undefined;
    const code = ownerCurrency ?? ctx.defaultCurrencyCode;
    if (!code) missing.push({ field: "price", reason: "currency_unknown" });
    else if (!currency.safeParse(code).success) missing.push({ field: "price", reason: "invalid" });
  }

  // Stock
  const inv = draft.inventory && isOwnerAuthoritative(draft.inventory.source) ? draft.inventory.value : undefined;
  if (!inv) {
    missing.push({ field: "stock", reason: "missing" });
  } else if (inv.tracked && !quantity.safeParse(inv.quantityOnHand).success) {
    missing.push({ field: "stock", reason: "invalid" });
  }

  // Image
  if ((ctx.requireImage ?? true) && !draft.image) {
    missing.push({ field: "image", reason: ctx.cameraEnabled ? "missing" : "camera_off" });
  }

  return missing;
}

/** Store-level facts required before a publish review. */
export type StoreFacts = {
  businessName?: Sourced<string>;
  contactEmail?: Sourced<string>;
  /** Explicit owner consent to show the contact publicly. Never inferred. */
  publicContactConsent?: Sourced<boolean>;
};

export type StoreField = "business_name" | "contact_email" | "public_contact_consent";

/** Pure helper: missing store-level facts. Optional brand/story/shipping never appear here. */
export function getMissingStoreFacts(store: StoreFacts): StoreField[] {
  const missing: StoreField[] = [];
  if (!store.businessName || !isOwnerAuthoritative(store.businessName.source) || !store.businessName.value.trim()) {
    missing.push("business_name");
  }
  if (!store.contactEmail || !isOwnerAuthoritative(store.contactEmail.source) || !store.contactEmail.value.includes("@")) {
    missing.push("contact_email");
  }
  const consent = store.publicContactConsent;
  // Only an explicit owner "yes" counts. A "no" means no public contact path, which blocks contact-to-buy.
  if (!consent || !isOwnerAuthoritative(consent.source) || consent.value !== true) {
    missing.push("public_contact_consent");
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Question composition
// ---------------------------------------------------------------------------

/**
 * One natural follow-up covering every missing name/price/stock fact at once,
 * or the image step when only that remains. Returns null when nothing is missing.
 */
export function composeFollowUpQuestion(draft: ProductDraftFacts, missing: readonly MissingField[]): string | null {
  const by = new Map(missing.map(m => [m.field, m.reason] as const));
  const parts: string[] = [];

  const titleReason = by.get("title");
  const guess = draft.title?.value.trim();
  if (titleReason === "unconfirmed_guess" && guess) parts.push(`is this the ${guess}`);
  else if (titleReason) parts.push("what's it called");

  const priceReason = by.get("price");
  if (priceReason === "currency_unknown") parts.push("which currency is that price in");
  else if (priceReason) parts.push("how much is it");

  if (by.has("stock")) parts.push("how many do you have, or should I skip tracking stock");

  if (parts.length > 0) {
    const sentence = joinSpoken(parts);
    return sentence.charAt(0).toUpperCase() + sentence.slice(1) + "?";
  }

  const imageReason = by.get("image");
  if (imageReason === "camera_off") return "Want to turn your camera on for a photo, or list it without one?";
  if (imageReason) return "Could you hold it up to the camera so I can grab a photo?";
  return null;
}

function joinSpoken(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** Store-level follow-up. Optional fields are never asked here. */
export function composeStoreQuestion(missing: readonly StoreField[]): string | null {
  const set = new Set(missing);
  if (set.has("business_name")) return "What's the name of your shop?";
  if (set.has("contact_email") && set.has("public_contact_consent")) {
    return "What email should customers use to reach you, and is it OK to show it publicly on your site?";
  }
  if (set.has("contact_email")) return "What email should customers use to reach you?";
  if (set.has("public_contact_consent")) return "Is it OK to show that email publicly on your site so customers can contact you?";
  return null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatPrice(priceMinor: number, currencyCode: string): string {
  const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: currencyCode });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  const major = priceMinor / 10 ** digits;
  const whole = Number.isInteger(major);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode,
    minimumFractionDigits: whole ? 0 : digits,
    maximumFractionDigits: digits,
  }).format(major);
}

export function formatStock(inv: InventoryFact): string {
  if (!inv.tracked) return "stock not tracked";
  if (inv.quantityOnHand === 0) return "sold out";
  return `${inv.quantityOnHand} in stock`;
}

// ---------------------------------------------------------------------------
// "Sold" statements (camera-off updates)
// ---------------------------------------------------------------------------

/** What the merchant said about sales of one resolved product. */
export type SaleStatement = {
  productId: string;
  /** "unspecified" = e.g. "I sold it" / "the vase sold" with no count. */
  units: number | "all" | "unspecified";
};

export type ProductSnapshot = { id: string; title: string; inventory: InventoryFact };

export type SalePlan =
  | { kind: "change"; change: CatalogChange; before: InventoryFact; after: InventoryFact }
  | { kind: "clarify"; question: string }
  | { kind: "no_change"; note: string };

/**
 * Pure helper mapping a sale statement to a proposed change or a clarification.
 * Never assumes "sold it" means sold out; never allows negative stock.
 * A proposed change still goes through the single combined review.
 */
export function planSaleUpdate(statement: SaleStatement, product: ProductSnapshot): SalePlan {
  const inv = product.inventory;
  const name = product.title;

  if (!inv.tracked) {
    if (statement.units === "all") {
      return {
        kind: "change",
        change: { type: "set_quantity", productId: product.id, newQuantity: 0 },
        before: inv,
        after: { tracked: true, quantityOnHand: 0 },
      };
    }
    return { kind: "clarify", question: `I'm not tracking a count for the ${name}. Is it sold out now, or still available?` };
  }

  const qty = inv.quantityOnHand;
  if (qty === 0) return { kind: "no_change", note: `The ${name} is already marked sold out.` };

  if (statement.units === "all") {
    return {
      kind: "change",
      change: { type: "set_quantity", productId: product.id, newQuantity: 0 },
      before: inv,
      after: { tracked: true, quantityOnHand: 0 },
    };
  }

  if (statement.units === "unspecified") {
    // With exactly one left, "sold one" and "sold out" are the same outcome: no genuine ambiguity.
    if (qty === 1) {
      return {
        kind: "change",
        change: { type: "adjust_quantity", productId: product.id, delta: -1 },
        before: inv,
        after: { tracked: true, quantityOnHand: 0 },
      };
    }
    return { kind: "clarify", question: `Did you sell one ${name}, or is it sold out?` };
  }

  const n = statement.units;
  if (!Number.isInteger(n) || n <= 0) return { kind: "clarify", question: `How many ${name}s did you sell?` };
  if (n > qty) {
    return { kind: "clarify", question: `I have ${qty} ${name}s listed. How many are left now?` };
  }
  return {
    kind: "change",
    change: { type: "adjust_quantity", productId: product.id, delta: -n },
    before: inv,
    after: { tracked: true, quantityOnHand: qty - n },
  };
}

// ---------------------------------------------------------------------------
// Combined reviews
// ---------------------------------------------------------------------------

export type ReviewState = { priceMinor: number; currencyCode: string; inventory: InventoryFact };

export type PublishReviewInput = {
  products: readonly { facts: ProductDraftFacts }[];
  store: StoreFacts;
  defaultCurrencyCode?: string;
  /** Optional, already-approved style phrase, e.g. "warm cream and green". */
  styleSummary?: string;
};

export type PublishReview =
  | { ok: true; text: string }
  | { ok: false; missingProducts: { index: number; missing: MissingField[] }[]; missingStore: StoreField[] };

/**
 * One combined pre-publication review for the whole store.
 * Refuses (ok: false) while any critical product or store fact is missing,
 * so the agent cannot reach review with guessed price/stock/consent.
 */
export function composePublishReview(input: PublishReviewInput): PublishReview {
  const missingProducts = input.products
    .map((p, index) => ({
      index,
      missing: getMissingCriticalFields(p.facts, { defaultCurrencyCode: input.defaultCurrencyCode, cameraEnabled: true }),
    }))
    .filter(p => p.missing.length > 0);
  const missingStore = getMissingStoreFacts(input.store);
  if (missingProducts.length > 0 || missingStore.length > 0 || input.products.length === 0) {
    return { ok: false, missingProducts, missingStore };
  }

  const lines = input.products.map(({ facts }) => {
    const code = facts.currencyCode?.value ?? input.defaultCurrencyCode!;
    return `${facts.title!.value.trim()}, ${formatPrice(facts.priceMinor!.value, code)}, ${formatStock(facts.inventory!.value)}`;
  });
  const count = lines.length === 1 ? "one product" : `${spokenCount(lines.length)} products`;
  const style = input.styleSummary ? ` in a ${input.styleSummary} style` : "";
  const text =
    `I have ${count} ready: ${lines.join("; ")}. ` +
    `Your site${style} will show ${input.store.contactEmail!.value} for inquiries. ` +
    `If that's all right, tap Publish on screen to make it public.`;
  return { ok: true, text };
}

export type ChangeReviewLine = { title: string; before: ReviewState; after: ReviewState };

/** One combined confirmation for every pending catalog change in this call. */
export function composeChangeReview(lines: readonly ChangeReviewLine[]): string {
  if (lines.length === 0) throw new Error("composeChangeReview requires at least one change");
  const parts = lines.map(({ title, before, after }) => {
    const deltas: string[] = [];
    if (before.priceMinor !== after.priceMinor || before.currencyCode !== after.currencyCode) {
      deltas.push(`${formatPrice(before.priceMinor, before.currencyCode)} → ${formatPrice(after.priceMinor, after.currencyCode)}`);
    }
    if (!sameInventory(before.inventory, after.inventory)) {
      deltas.push(`${formatStockShort(before.inventory)} → ${formatStockShort(after.inventory)}`);
    }
    return `${title}, ${deltas.join(", ") || "no change"}`;
  });
  const target = lines.length === 1 ? "this change" : lines.length === 2 ? "both changes" : `all ${spokenCount(lines.length)} changes`;
  return `Here's what I'll change: ${parts.join("; ")}. If that's right, tap Confirm on screen to apply ${target}.`;
}

function sameInventory(a: InventoryFact, b: InventoryFact): boolean {
  if (a.tracked !== b.tracked) return false;
  return !a.tracked || (b.tracked && a.quantityOnHand === b.quantityOnHand);
}

function formatStockShort(inv: InventoryFact): string {
  if (!inv.tracked) return "not tracked";
  if (inv.quantityOnHand === 0) return "sold out";
  return `${inv.quantityOnHand} left`;
}

function spokenCount(n: number): string {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  return words[n] ?? String(n);
}

// ---------------------------------------------------------------------------
// Prompt policy
// ---------------------------------------------------------------------------

export type ClientToolName = (typeof CLIENT_TOOL_NAMES)[number];

/** Compile-time checked tool reference. */
const tool = <T extends ClientToolName>(name: T): T => name;

/** ~2-minute first-store intake is a DESIGN TARGET for pacing, not a timeout or a measured result. */
export const INTAKE_DESIGN_TARGET_SECONDS = 120;

export type PolicyRule = { id: string; text: string };

/** Individually testable rules; `buildMerchantConversationPolicy` renders them. */
export const MERCHANT_CONVERSATION_RULES: readonly PolicyRule[] = [
  { id: "goal", text: "Goal: collect the required inventory facts with as few questions as possible. Keep turns short; aim for a first store with a few products in about two minutes (a pacing target, never a reason to cut the merchant off)." },
  { id: "extract", text: "Extract every fact the merchant volunteers in a single sentence (name, price, count, store name, contact) and record it immediately. Never ask again for a fact already given; if unsure you heard it right, read it back in the review instead of re-asking." },
  { id: "bundle", text: "For each product, collect name, price and stock together in one natural question, asking only for the parts still missing." },
  { id: "only-missing", text: "Ask only for missing critical facts or genuine ambiguity. Critical: product name, price, stock (a count or an explicit choice not to track stock), a photo or an explicit no-photo choice, store name, contact email, and consent to show it publicly." },
  { id: "optional", text: "Brand story, style, colors, audience, shipping and pickup are optional. Accept them if offered; at most offer one short optional question after critical facts are complete, and never let them block the demo." },
  { id: "no-infer", text: "Never infer or suggest as fact a price, a stock count, consent to show contact details publicly, or approval. Photos are evidence of what an item looks like, never of its price or quantity. If the camera guess conflicts with the merchant, the merchant wins." },
  { id: "stock", text: "If stock is vague (\"a few\", \"plenty\") or unknown, ask for a number or offer to list it without tracking stock. Never default to 1 or any other count." },
  { id: "sold", text: "If the merchant says an item \"sold\" without a count, ask whether one sold or it is sold out, unless only one was in stock. \"Sold out\" means stock 0; \"sold N\" subtracts N and can never go below zero." },
  { id: "identity", text: "Resolve product references with the catalog. If more than one product could match, ask which one by name; never pick arbitrarily." },
  { id: "one-review", text: "Give exactly one combined review at the end: all products (or all pending changes) in one readback. A returning merchant editing several products gets one combined confirmation, not one per product." },
  { id: "approval", text: "You cannot apply changes or publish. Approval happens only when the owner taps Confirm/Publish on screen. Never say something is saved, applied, published or live until a tool result says so." },
  { id: "camera", text: "Camera off means no new photos: do not request captures. Offer to turn the camera on or list without a photo. Camera state never affects audio." },
  { id: "style", text: "One question per turn, plain language, no jargon, no filler, no long recaps mid-call." },
] as const;

export type PolicyContext = {
  mode: "create" | "update";
  cameraEnabled: boolean;
  storeName?: string;
};

/** Renders the policy prompt for the managed ElevenLabs agent. Deterministic. */
export function buildMerchantConversationPolicy(ctx: PolicyContext): string {
  const opening =
    ctx.mode === "create"
      ? "Opening: \"Hi! Let's build your storefront. What do you sell, and what's your shop called?\""
      : `Opening: "Welcome back${ctx.storeName ? ` to ${ctx.storeName}` : ""}. What would you like to change?"`;
  const camera = ctx.cameraEnabled
    ? "Camera is ON: you may request a photo of the current product."
    : "Camera is OFF: do not request photos.";
  const tools = [
    `- ${tool("upsert_business_brief")}: record store facts as soon as they are said.`,
    `- ${tool("create_product_draft")} then ${tool("record_product_details")}: record product facts as soon as they are said, marking them owner-sourced.`,
    ...(ctx.cameraEnabled ? [`- ${tool("capture_product_photo")}: only with the camera on; claim success only after the tool returns a capture ID.`] : []),
    `- ${tool("get_catalog_summary")} and ${tool("resolve_product_reference")}: look up existing products before proposing edits.`,
    `- ${tool("preview_catalog_changes")} then ${tool("show_confirmation")}: one preview for all pending changes, then one confirmation screen.`,
    `- ${tool("get_build_status")}: report real build state only.`,
  ];
  return [
    "You are Shopcall's storefront assistant on a live voice call with a small-business owner.",
    `Mode: ${ctx.mode === "create" ? "first store" : "returning merchant update"}. ${camera}`,
    opening,
    "",
    "Rules:",
    ...MERCHANT_CONVERSATION_RULES.map(r => `- ${r.text}`),
    "",
    "Tools:",
    ...tools,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Example call scripts (fixtures; no live calls, no TTS)
// ---------------------------------------------------------------------------

export type ScriptTurn =
  | {
      speaker: "merchant";
      text: string;
      /** Facts extracted from this utterance, keyed by draft label. */
      productFacts?: Record<string, ProductDraftFacts>;
      storeFacts?: StoreFacts;
      images?: Record<string, ImageFact>;
    }
  | {
      speaker: "agent";
      text: string;
      /** Critical fields this turn asks for, by draft label. */
      asks?: { draft: string; fields: CriticalField[] };
      asksStore?: StoreField[];
      kind: "question" | "capture" | "clarify" | "review" | "ack";
    };

export type CallScript = {
  id: "first-store" | "camera-off-updates" | "ambiguous-sold-it";
  title: string;
  mode: "create" | "update";
  cameraEnabled: boolean;
  defaultCurrencyCode: string;
  turns: readonly ScriptTurn[];
};

const voice = <T>(value: T): Sourced<T> => ({ value, source: "owner_voice" });
const tracked = (n: number): InventoryFact => ({ tracked: true, quantityOnHand: n });

const FIRST_STORE_REVIEW = composePublishReview({
  defaultCurrencyCode: "USD",
  styleSummary: "warm cream and green",
  store: { businessName: voice("Clay & Kiln"), contactEmail: voice("hello@clayandkiln.example"), publicContactConsent: voice(true) },
  products: [
    { facts: { title: voice("Speckled blue mug"), priceMinor: voice(2400), inventory: voice(tracked(4)), image: { kind: "capture", captureId: "cap-1" } } },
    { facts: { title: voice("White bowl"), priceMinor: voice(1800), inventory: voice(tracked(6)), image: { kind: "capture", captureId: "cap-2" } } },
    { facts: { title: voice("Tall vase"), priceMinor: voice(4500), inventory: voice({ tracked: false }), image: { kind: "capture", captureId: "cap-3" } } },
  ],
});
if (!FIRST_STORE_REVIEW.ok) throw new Error("first-store example review must be complete");

const usd = (priceMinor: number, inventory: InventoryFact): ReviewState => ({ priceMinor, currencyCode: "USD", inventory });

export const EXAMPLE_CALL_SCRIPTS: readonly CallScript[] = [
  {
    id: "first-store",
    title: "First store, camera on, three products",
    mode: "create",
    cameraEnabled: true,
    defaultCurrencyCode: "USD",
    turns: [
      { speaker: "agent", kind: "question", text: "Hi! Let's build your storefront. What do you sell, and what's your shop called?" },
      {
        speaker: "merchant",
        text: "I'm Clay & Kiln, handmade ceramics, warm cream and green vibe. This is my speckled blue mug, twenty-four dollars, four in stock.",
        storeFacts: { businessName: voice("Clay & Kiln") },
        productFacts: { mug: { title: voice("Speckled blue mug"), priceMinor: voice(2400), inventory: voice(tracked(4)) } },
      },
      { speaker: "agent", kind: "capture", text: "Love it. Hold the mug steady for a photo.", asks: { draft: "mug", fields: ["image"] } },
      {
        speaker: "merchant",
        text: "Here. Next is a white bowl, eighteen, I've got six.",
        images: { mug: { kind: "capture", captureId: "cap-1" } },
        productFacts: { bowl: { title: voice("White bowl"), priceMinor: voice(1800), inventory: voice(tracked(6)) } },
      },
      { speaker: "agent", kind: "capture", text: "Got the mug. Show me the bowl.", asks: { draft: "bowl", fields: ["image"] } },
      {
        speaker: "merchant",
        text: "Here. Last one is this tall vase.",
        images: { bowl: { kind: "capture", captureId: "cap-2" } },
        productFacts: { vase: { title: voice("Tall vase") } },
      },
      {
        speaker: "agent",
        kind: "question",
        text: "Hold it up for a photo. How much is it, and how many do you have, or should I skip tracking stock?",
        asks: { draft: "vase", fields: ["image", "price", "stock"] },
      },
      {
        speaker: "merchant",
        text: "Forty-five. Don't track it, I make them to order.",
        images: { vase: { kind: "capture", captureId: "cap-3" } },
        productFacts: { vase: { priceMinor: voice(4500), inventory: voice({ tracked: false }) } },
      },
      {
        speaker: "agent",
        kind: "question",
        text: "What email should customers use to reach you, and is it OK to show it publicly on your site?",
        asksStore: ["contact_email", "public_contact_consent"],
      },
      {
        speaker: "merchant",
        text: "hello@clayandkiln.example, and yes, show it.",
        storeFacts: { contactEmail: voice("hello@clayandkiln.example"), publicContactConsent: voice(true) },
      },
      { speaker: "agent", kind: "review", text: FIRST_STORE_REVIEW.text },
    ],
  },
  {
    id: "camera-off-updates",
    title: "Returning merchant, camera off, several edits",
    mode: "update",
    cameraEnabled: false,
    defaultCurrencyCode: "USD",
    turns: [
      { speaker: "agent", kind: "question", text: "Welcome back to Clay & Kiln. What would you like to change?" },
      { speaker: "merchant", text: "The tall vase sold out, the blue mug is now twenty, and I made three more white bowls." },
      {
        speaker: "agent",
        kind: "review",
        text: composeChangeReview([
          { title: "Tall vase", before: usd(4500, { tracked: false }), after: usd(4500, tracked(0)) },
          { title: "Speckled blue mug", before: usd(2400, tracked(4)), after: usd(2000, tracked(4)) },
          { title: "White bowl", before: usd(1800, tracked(6)), after: usd(1800, tracked(9)) },
        ]),
      },
    ],
  },
  {
    id: "ambiguous-sold-it",
    title: "Ambiguous \"sold it\"",
    mode: "update",
    cameraEnabled: false,
    defaultCurrencyCode: "USD",
    turns: [
      { speaker: "agent", kind: "question", text: "Welcome back to Clay & Kiln. What would you like to change?" },
      { speaker: "merchant", text: "I sold the blue mug." },
      { speaker: "agent", kind: "clarify", text: "Did you sell one Speckled blue mug, or is it sold out?" },
      { speaker: "merchant", text: "Just one." },
      {
        speaker: "agent",
        kind: "review",
        text: composeChangeReview([{ title: "Speckled blue mug", before: usd(2400, tracked(4)), after: usd(2400, tracked(3)) }]),
      },
    ],
  },
];

/**
 * Rough spoken-duration ESTIMATE for a script (≈2.5 words/s plus 1.5 s turn
 * latency). Used only to keep fixtures near the design target; not a measurement.
 */
export function estimateScriptSeconds(script: CallScript): number {
  const words = script.turns.reduce((n, t) => n + t.text.split(/\s+/).filter(Boolean).length, 0);
  return Math.round(words / 2.5 + script.turns.length * 1.5);
}
