import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "../../src/features/call/api";
import { createClientTools, type ToolDeps } from "../../src/features/call/clientTools";
import { draftsReducer, initialDrafts, type DraftsState } from "../../src/features/call/drafts";

const CALL = "33333333-3333-4333-8333-333333333333";
const BIZ = "44444444-4444-4444-8444-444444444444";
const DRAFT = "55555555-5555-4555-8555-555555555555";
const PRODUCT = "66666666-6666-4666-8666-666666666666";

type Seen = { method: string; path: string; body: unknown }[];
function fakeFetch(routes: Record<string, (body: unknown) => { status: number; json: unknown }>, seen: Seen): typeof fetch {
  return (async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    seen.push({ method, path, body });
    const r = routes[`${method} ${path}`];
    if (!r) return new Response("not found", { status: 404 });
    const { status, json } = r(body);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function setup(routes: Parameters<typeof fakeFetch>[0], over: Partial<ToolDeps> = {}) {
  const seen: Seen = [];
  let drafts: DraftsState = draftsReducer(initialDrafts, { type: "draft_saved", draft: { id: DRAFT } });
  const opened: string[] = [];
  const remembered = new Map<string, unknown>();
  const deps: ToolDeps = {
    api: createApiClient(fakeFetch(routes, seen)),
    callId: () => CALL, businessId: () => BIZ, catalogRevision: () => 7,
    drafts: () => drafts, dispatch: a => { drafts = draftsReducer(drafts, a); },
    captureForDraft: async () => ({ ok: true, captureId: "cap", thumbnailUrl: "https://x/t.jpg" }),
    isCameraOn: () => true,
    rememberProposal: (_k, p) => remembered.set(p.id, p),
    openConfirmation: (_k, id) => { if (!remembered.has(id)) return false; opened.push(id); return true; },
    newIdempotencyKey: () => "key-1",
    ...over,
  };
  return { tools: createClientTools(deps), seen, opened, getDrafts: () => drafts };
}

const parse = (s: string) => JSON.parse(s);

test("missing backend route reports NOT_READY, never success", async () => {
  const { tools } = setup({});
  const res = parse(await tools.create_product_draft({ proposedTitle: "Blue mug" }));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "NOT_READY");
});

test("create_product_draft uses this session's call ID, ignoring agent-supplied IDs", async () => {
  const { tools, seen, getDrafts } = setup({ "POST /api/drafts": () => ({ status: 200, json: { ok: true, data: { id: PRODUCT, title: "Blue mug" } } }) });
  const res = parse(await tools.create_product_draft({ proposedTitle: "Blue mug", callId: "attacker" }));
  assert.equal(res.ok, true);
  assert.equal((seen[0].body as { callId: string }).callId, CALL);
  assert.equal(getDrafts().byId[PRODUCT].title, "Blue mug");
});

test("capture is refused while camera is off", async () => {
  let called = false;
  const { tools } = setup({}, { isCameraOn: () => false, captureForDraft: async () => { called = true; return { ok: true, captureId: "c", thumbnailUrl: "t" }; } });
  const res = parse(await tools.capture_product_photo({ productDraftId: DRAFT }));
  assert.equal(res.error.code, "CAMERA_OFF");
  assert.equal(called, false);
});

test("capture for an unknown draft is refused", async () => {
  const { tools } = setup({});
  const res = parse(await tools.capture_product_photo({ productDraftId: PRODUCT }));
  assert.equal(res.error.code, "NOT_FOUND");
});

test("record_product_details rejects float prices before calling backend", async () => {
  const { tools, seen } = setup({});
  const res = parse(await tools.record_product_details({ productDraftId: DRAFT, fields: { priceMinor: 24.5 } }));
  assert.equal(res.error.code, "INVALID_INPUT");
  assert.equal(seen.length, 0);
});

test("preview hides the approval nonce from the agent; show_confirmation never approves", async () => {
  const proposal = { id: "prop-1", expiresAt: new Date(Date.now() + 60000).toISOString(), approvalNonce: "SECRET", items: [{ label: "Blue mug", before: "$24.00", after: "$20.00" }] };
  const { tools, seen, opened } = setup({ "POST /api/catalog/proposals": () => ({ status: 200, json: { ok: true, data: proposal } }) });
  const preview = await tools.preview_catalog_changes({ changes: [{ type: "set_price", productId: PRODUCT, newPriceMinor: 2000, currencyCode: "USD" }] });
  assert.equal(preview.includes("SECRET"), false);
  assert.equal((seen[0].body as { expectedCatalogRevision: number }).expectedCatalogRevision, 7);
  const shown = parse(await tools.show_confirmation({ kind: "catalog_change", proposalId: "prop-1" }));
  assert.equal(shown.data.approved, false);
  assert.deepEqual(opened, ["prop-1"]);
  assert.equal(seen.some(s => s.path.endsWith("/confirm")), false);
});

test("show_confirmation for an unknown proposal fails", async () => {
  const { tools } = setup({});
  assert.equal(parse(await tools.show_confirmation({ kind: "publish", proposalId: "nope" })).error.code, "NOT_FOUND");
});

test("ambiguous product reference asks for clarification", async () => {
  const { tools } = setup({ "POST /api/catalog/resolve": () => ({ status: 200, json: { ok: true, data: { matches: [{ productId: PRODUCT, title: "Blue mug", imageUrl: null }, { productId: DRAFT, title: "Blue mug large", imageUrl: null }] } } }) });
  assert.equal(parse(await tools.resolve_product_reference({ phrase: "the blue mug" })).data.needsClarification, true);
});

test("malformed backend body is an error, not success", async () => {
  const { tools } = setup({ "GET /api/session": () => ({ status: 200, json: { business: "x" } }) });
  assert.equal(parse(await tools.get_catalog_summary({})).ok, false);
});
