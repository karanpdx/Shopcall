import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "../../src/features/call/api";
import { createClientTools, type ToolDeps } from "../../src/features/call/clientTools";
import { draftsReducer, initialDrafts, type DraftsState } from "../../src/features/call/drafts";

const CALL = "33333333-3333-4333-8333-333333333333";
const BIZ = "44444444-4444-4444-8444-444444444444";
const DRAFT = "55555555-5555-4555-8555-555555555555";
const PRODUCT = "66666666-6666-4666-8666-666666666666";
const PROPOSAL = "77777777-7777-4777-8777-777777777777";
type Seen = { method: string; path: string; body: any }[];
function setup(handler: (body: any) => unknown = () => ({}), over: Partial<ToolDeps> = {}) {
  const seen: Seen = [];
  let drafts: DraftsState = draftsReducer(initialDrafts, { type: "draft_saved", draft: { id: DRAFT } });
  const api = createApiClient((async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    seen.push({ method: init?.method ?? "GET", path: String(input), body });
    return Response.json({ ok: true, data: handler(body) });
  }) as typeof fetch);
  const deps: ToolDeps = { api, callId: () => CALL, businessId: () => BIZ, catalogRevision: () => 7, drafts: () => drafts,
    dispatch: action => { drafts = draftsReducer(drafts, action); }, captureForDraft: async () => ({ ok: true, captureId: "cap", thumbnailUrl: "https://x/image.jpg" }), isCameraOn: () => true,
    rememberProposal: () => {}, openConfirmation: () => true, newIdempotencyKey: () => "key-1", ...over };
  return { tools: createClientTools(deps), seen, getDrafts: () => drafts };
}
const parse = (value: string) => JSON.parse(value);

test("data tools use the authenticated C bridge with current call ID and idempotency key", async () => {
  const { tools, seen, getDrafts } = setup(() => ({ productDraftId: PRODUCT, draft: { id: PRODUCT, fields: { title: "Blue mug", priceMinor: 2400 }, imageAssetId: null, proposalId: null } }));
  const result = parse(await tools.create_product_draft({ proposedTitle: "Blue mug" }));
  assert.equal(result.ok, true);
  assert.equal(seen[0].path, "/api/voice/tools");
  assert.deepEqual(seen[0].body, { callId: CALL, name: "create_product_draft", arguments: { proposedTitle: "Blue mug" }, idempotencyKey: "key-1" });
  assert.equal(getDrafts().byId[PRODUCT].title, "Blue mug");
  assert.equal(getDrafts().byId[PRODUCT].priceMinor, 2400);
  const forged = parse(await tools.create_product_draft({ proposedTitle: "Other", callId: "attacker" }));
  assert.equal(forged.ok, false);
  assert.equal(seen.length, 1);
});

test("flat product detail arguments match provider schema; floating prices are rejected locally", async () => {
  const { tools, seen } = setup(() => ({ draft: { id: DRAFT, fields: { title: "Blue mug", priceMinor: 2000 } } }));
  assert.equal(parse(await tools.record_product_details({ productDraftId: DRAFT, priceMinor: 24.5 })).ok, false);
  assert.equal(seen.length, 0);
  assert.equal(parse(await tools.record_product_details({ productDraftId: DRAFT, title: "Blue mug", priceMinor: 2000 })).ok, true);
  assert.deepEqual(seen[0].body.arguments, { productDraftId: DRAFT, title: "Blue mug", priceMinor: 2000 });
});

test("camera-off or unknown-draft capture never starts camera/upload", async () => {
  let called = false;
  const { tools, seen } = setup(() => ({}), { isCameraOn: () => false, captureForDraft: async () => { called = true; return { ok: true, captureId: "cap", thumbnailUrl: "image" }; } });
  assert.equal(parse(await tools.capture_product_photo({ productDraftId: DRAFT })).error.code, "CAMERA_OFF");
  assert.equal(called, false); assert.equal(seen.length, 0);
  const unknown = setup();
  assert.equal(parse(await unknown.tools.capture_product_photo({ productDraftId: PRODUCT })).error.code, "NOT_FOUND");
});

test("capture reports success only from actual ID-bound image upload result", async () => {
  const { tools, seen } = setup(() => ({ action: "capture_photo_in_browser", saved: false }));
  const result = parse(await tools.capture_product_photo({ productDraftId: DRAFT }));
  assert.equal(seen[0].body.name, "capture_product_photo");
  assert.equal(result.data.productDraftId, DRAFT);
  assert.equal(result.data.captureId, "cap");
  assert.equal(result.data.saved, true);
});

test("review can open but agent receives no owner confirmation token and never applies", async () => {
  let opened = false;
  const { tools, seen } = setup(() => ({ action: "show_catalog_review", approved: false, applied: false }), { openConfirmation: async () => { const ownerOnlyToken = "SECRET_NOT_FOR_AGENT"; opened = ownerOnlyToken.length > 0; return true; } });
  const result = await tools.show_confirmation({ kind: "catalog_change", proposalId: PROPOSAL });
  assert.equal(opened, true);
  assert.equal(result.includes("SECRET_NOT_FOR_AGENT"), false);
  assert.equal(parse(result).data.approved, false);
  assert.equal(seen.some(request => request.path.endsWith("/confirm")), false);
});

test("ambiguous references retain backend clarification result", async () => {
  const { tools } = setup(() => ({ matches: [{ id: PRODUCT }, { id: DRAFT }], needsClarification: true, resolvedProductId: null }));
  assert.equal(parse(await tools.resolve_product_reference({ phrase: "the blue mug" })).data.needsClarification, true);
});

test("malformed bridge bodies are errors, never success", async () => {
  const api = createApiClient((async () => Response.json({ business: "x" })) as typeof fetch);
  const { tools } = setup(undefined, { api });
  assert.equal(parse(await tools.get_catalog_summary({})).ok, false);
});
