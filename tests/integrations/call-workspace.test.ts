import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { body, call, createAndApprove, ORIGIN, params, signIn } from "../helpers/backend";
import * as calls from "../../src/app/api/calls/route";
import * as callById from "../../src/app/api/calls/[id]/route";
import * as endCall from "../../src/app/api/calls/[id]/end/route";
import * as workingDrafts from "../../src/app/api/calls/[id]/drafts/route";
import * as workingDraft from "../../src/app/api/calls/[id]/drafts/[draftId]/route";
import * as images from "../../src/app/api/calls/[id]/drafts/[draftId]/images/route";
import * as productProposal from "../../src/app/api/calls/[id]/drafts/[draftId]/proposal/route";
import * as tools from "../../src/app/api/voice/tools/route";
import { repository, SqliteRepository } from "../../src/server/repository";
import { CallWorkspaceStore } from "../../src/integrations/call-workspace/store";
import { CallWorkspaceService, type WorkspaceCatalogRepository } from "../../src/integrations/call-workspace/service";
import { callWorkspace } from "../../src/integrations/call-workspace/runtime";
import { createVoiceSessionHandler } from "../../src/integrations/call-workspace/session";
import type { VoiceCallContext } from "../../src/integrations/elevenlabs/service";

process.env.APP_BASE_URL = ORIGIN;
async function start(cookie: string, mode: "create" | "update" = "create") {
  const result = await body(await calls.POST(call("POST", "/api/calls", { cookie, body: { mode, idempotencyKey: randomUUID() } })));
  assert.equal(result.ok, true);
  return result.data.call as { id: string; publicationReviewId: string };
}
async function invoke(cookie: string, callId: string, name: string, args: unknown, key: string = randomUUID()) {
  return tools.POST(call("POST", "/api/voice/tools", { cookie, body: { callId, name, arguments: args, idempotencyKey: key } }));
}

test("publication review handle mix-up opens only current call preview and never pretends to be a build job", async () => {
  const a = await signIn("review-handle-owner@example.com"); const c = await start(a.cookie);
  const shown = await body(await invoke(a.cookie, c.id, "show_confirmation", { kind: "catalog_change", proposalId: c.publicationReviewId }));
  assert.equal(shown.ok, true);
  assert.equal(shown.data.action, "show_publication_review");
  assert.equal(shown.data.proposalId, c.publicationReviewId);
  assert.equal(shown.data.approved, false);
  assert.equal(shown.data.published, false);
  const status = await body(await invoke(a.cookie, c.id, "get_build_status", { buildJobId: c.publicationReviewId }));
  assert.equal(status.ok, true);
  assert.equal(status.data.job, null);
  assert.equal(status.data.reason, "REVIEW_HANDLE_IS_NOT_BUILD_JOB");
  assert.deepEqual(await repository().listProducts(a.session.business.id), []);
  assert.equal((await invoke(a.cookie, c.id, "show_confirmation", { kind: "publish", proposalId: randomUUID() })).status, 404);
});

test("call APIs require owner and strict origin, derive identity from session, and retain drafts after end", async () => {
  assert.equal((await calls.POST(call("POST", "/api/calls", { body: { mode: "create", idempotencyKey: "missing" } }))).status, 401);
  const { cookie, session } = await signIn("call-a@example.com");
  assert.equal((await calls.POST(call("POST", "/api/calls", { cookie, origin: null, body: { mode: "create", idempotencyKey: "no-origin" } }))).status, 403);
  assert.equal((await calls.POST(call("POST", "/api/calls", { cookie, origin: "https://evil.example", body: { mode: "create", idempotencyKey: "evil" } }))).status, 403);
  assert.equal((await calls.POST(call("POST", "/api/calls", { cookie, body: { mode: "create", idempotencyKey: "forged", ownerId: randomUUID() } }))).status, 400);
  const c = await start(cookie);
  const created = await body(await workingDrafts.POST(call("POST", `/api/calls/${c.id}/drafts`, { cookie, body: { proposedTitle: "Blue mug", idempotencyKey: "draft-one" } }), params({ id: c.id })));
  const duplicate = await body(await workingDrafts.POST(call("POST", `/api/calls/${c.id}/drafts`, { cookie, body: { proposedTitle: "Blue mug", idempotencyKey: "draft-one" } }), params({ id: c.id })));
  assert.equal(created.data.id, duplicate.data.id);
  assert.equal(created.data.businessId, session.business.id);
  const other = await signIn("call-b@example.com");
  assert.equal((await callById.GET(call("GET", `/api/calls/${c.id}`, { cookie: other.cookie }), params({ id: c.id }))).status, 404);
  await endCall.POST(call("POST", `/api/calls/${c.id}/end`, { cookie }), params({ id: c.id }));
  const ended = await body(await callById.GET(call("GET", `/api/calls/${c.id}`, { cookie }), params({ id: c.id })));
  assert.equal(ended.data.call.status, "ended");
  assert.equal(ended.data.drafts.length, 1);
  assert.equal((await invoke(cookie, c.id, "get_catalog_summary", {})).status, 409);
  // Owner may correct saved draft in post-call UI, without reopening microphone.
  const corrected = await body(await workingDraft.PATCH(call("PATCH", `/api/calls/${c.id}/drafts/${created.data.id}`, { cookie, body: { title: "White bowl" } }), params({ id: c.id, draftId: created.data.id })));
  assert.equal(corrected.data.draft.fields.title, "White bowl");
});

test("session issuance uses real call ownership, fails before provider for wrong owner/end, and returns no-store", async () => {
  const a = await signIn("voice-owner@example.com"); const b = await signIn("voice-other@example.com");
  const c = await start(a.cookie);
  let issued = 0; let context: VoiceCallContext | undefined;
  const handler = createVoiceSessionHandler({ workspace: callWorkspace, issue: async (input, authorization) => {
    issued++; context = input; await authorization.assertOwnerCall(input);
    return { signedUrl: "wss://api.elevenlabs.io/v1/convai/conversation?conversation_signature=mock-only", connectionType: "websocket", callId: input.callId };
  } });
  assert.equal((await handler(call("POST", "/api/voice/session", { cookie: b.cookie, body: { callId: c.id } }))).status, 404);
  assert.equal(issued, 0);
  const success = await handler(call("POST", "/api/voice/session", { cookie: a.cookie, body: { callId: c.id } }));
  assert.equal(success.status, 200);
  assert.equal(success.headers.get("cache-control"), "no-store");
  assert.deepEqual(context, { ownerUserId: a.session.owner.id, businessId: a.session.business.id, callId: c.id });
  await endCall.POST(call("POST", `/api/calls/${c.id}/end`, { cookie: a.cookie }), params({ id: c.id }));
  assert.equal((await handler(call("POST", "/api/voice/session", { cookie: a.cookie, body: { callId: c.id } }))).status, 409);
  assert.equal(issued, 1);
});

test("ending call while credentials issue prevents browser credential return; reconnect rate limit persists", async () => {
  const a = await signIn("voice-race@example.com"); const c = await start(a.cookie);
  const handler = createVoiceSessionHandler({ workspace: callWorkspace, issue: async (input, authorization) => {
    await authorization.assertOwnerCall(input);
    callWorkspace().store.endCall({ ownerId: a.session.owner.id, businessId: a.session.business.id }, input.callId);
    return { signedUrl: "wss://api.elevenlabs.io/v1/convai/conversation?conversation_signature=mock-only", connectionType: "websocket", callId: input.callId };
  } });
  const ended = await handler(call("POST", "/api/voice/session", { cookie: a.cookie, body: { callId: c.id } }));
  assert.equal(ended.status, 409);
  assert.ok(!(await ended.text()).includes("conversation_signature"));
  const c2 = await start(a.cookie);
  const owner = { ownerId: a.session.owner.id, businessId: a.session.business.id };
  for (let i = 0; i < 4; i++) callWorkspace().store.reserveVoiceAttempt(owner, c2.id);
  assert.throws(() => callWorkspace().store.reserveVoiceAttempt(owner, c2.id), { code: "RATE_LIMITED" });
});

test("partial draft tools and ID-bound image upload make a full proposal without applying it", async () => {
  const a = await signIn("capture-owner@example.com"); const c = await start(a.cookie);
  const one = (await body(await invoke(a.cookie, c.id, "create_product_draft", { proposedTitle: "Blue mug" }, "one"))).data;
  const two = (await body(await invoke(a.cookie, c.id, "create_product_draft", { proposedTitle: "White bowl" }, "two"))).data;
  assert.equal(one.ready, false);
  assert.equal(one.draft.fields.priceMinor, undefined);
  const details = await body(await invoke(a.cookie, c.id, "record_product_details", { productDraftId: one.productDraftId, priceMinor: 2400, quantityOnHand: 4 }));
  assert.deepEqual(details.data.missing, ["imageAssetId"]);
  const capture = await body(await invoke(a.cookie, c.id, "capture_product_photo", { productDraftId: one.productDraftId }));
  assert.equal(capture.data.captured, false);
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "blue" } }).png().toBuffer();
  const form = new FormData(); form.set("file", new File([png], "mug.png", { type: "image/png" }));
  const uploaded = await body(await images.POST(call("POST", `/api/calls/${c.id}/drafts/${one.productDraftId}/images`, { cookie: a.cookie, raw: form }), params({ id: c.id, draftId: one.productDraftId })));
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.data.productDraftId, one.productDraftId);
  assert.equal(uploaded.data.ready, true);
  const workspace = await body(await callById.GET(call("GET", `/api/calls/${c.id}`, { cookie: a.cookie }), params({ id: c.id })));
  assert.equal(workspace.data.drafts.find((d: { id: string }) => d.id === two.productDraftId).imageAssetId, null);
  const proposed = await body(await productProposal.POST(call("POST", `/api/calls/${c.id}/drafts/${one.productDraftId}/proposal`, { cookie: a.cookie }), params({ id: c.id, draftId: one.productDraftId })));
  assert.equal(proposed.ok, true);
  assert.equal(proposed.data.proposal.status, "pending");
  assert.equal(proposed.data.proposal.changes[0].product.imageAssetId, uploaded.data.captureId);
  assert.equal((await repository().listProducts(a.session.business.id)).length, 0);
  const replay = await body(await productProposal.POST(call("POST", `/api/calls/${c.id}/drafts/${one.productDraftId}/proposal`, { cookie: a.cookie }), params({ id: c.id, draftId: one.productDraftId })));
  assert.equal(replay.data.proposal.id, proposed.data.proposal.id);
  assert.equal((await invoke(a.cookie, c.id, "record_product_details", { productDraftId: one.productDraftId, priceMinor: 2200 })).status, 409);
  assert.equal((await invoke(a.cookie, c.id, "show_confirmation", { kind: "catalog_change", proposalId: proposed.data.proposal.id, confirmed: true })).status, 400);
  const shown = await body(await invoke(a.cookie, c.id, "show_confirmation", { kind: "catalog_change", proposalId: proposed.data.proposal.id }));
  assert.equal(shown.data.applied, false);
  assert.ok(!JSON.stringify(shown).includes("confirmationToken"));
});

test("lookup ambiguity and combined price/stock proposal retain canonical IDs/revisions and never apply from tools", async () => {
  const a = await signIn("update-owner@example.com"); const c = await start(a.cookie, "update");
  const p1 = await createAndApprove(a.cookie, { type: "create_product", product: { name: "Blue mug", priceCents: 2400, inventoryCount: 4 } });
  await createAndApprove(a.cookie, { type: "create_product", product: { name: "Blue mug large", priceCents: 3200, inventoryCount: 2 } });
  const vase = await createAndApprove(a.cookie, { type: "create_product", product: { name: "Tall vase", priceCents: 4500, inventoryCount: 1 } });
  const ambiguous = await body(await invoke(a.cookie, c.id, "resolve_product_reference", { phrase: "the blue mug" }));
  assert.equal(ambiguous.data.needsClarification, true); assert.equal(ambiguous.data.resolvedProductId, null);
  const proposal = await body(await invoke(a.cookie, c.id, "preview_catalog_changes", { changes: [
    { type: "set_price", productId: p1.data.product.id, newPriceMinor: 2000, currencyCode: "USD" },
    { type: "set_quantity", productId: vase.data.product.id, newQuantity: 0 },
  ] }));
  assert.equal(proposal.ok, true);
  assert.equal(proposal.data.proposal.changes.length, 2);
  assert.equal(proposal.data.applied, false);
  assert.equal((await repository().getProduct(a.session.business.id, p1.data.product.id))!.priceCents, 2400);
  assert.equal((await repository().getProduct(a.session.business.id, vase.data.product.id))!.inventoryCount, 1);
  assert.equal((await invoke(a.cookie, c.id, "apply_confirmed_catalog_changes", {})).status, 400);
  const foreign = await signIn("foreign-owner@example.com"); const fc = await start(foreign.cookie);
  assert.equal((await invoke(foreign.cookie, fc.id, "preview_catalog_changes", { changes: [{ type: "set_quantity", productId: vase.data.product.id, newQuantity: 0 }] })).status, 404);
});

test("existing B-uploaded asset attaches only to exact owner draft and never accepts caller-supplied image URL", async () => {
  const a = await signIn("asset-owner@example.com"); const c = await start(a.cookie);
  const draft = (await body(await invoke(a.cookie, c.id, "create_product_draft", {}))).data.productDraftId;
  const foreign = await signIn("asset-foreign@example.com");
  const foreignAsset = repository().createAsset({ id: randomUUID(), businessId: foreign.session.business.id, storageKey: "fixture/foreign.png", mimeType: "image/png", sizeBytes: 80, width: 4, height: 4 });
  const path = `/api/calls/${c.id}/drafts/${draft}/images`;
  const bound = params({ id: c.id, draftId: draft });
  assert.equal((await images.POST(call("POST", path, { cookie: a.cookie, body: { imageAssetId: foreignAsset.id, capturedAt: new Date().toISOString() } }), bound)).status, 404);
  const ownAsset = repository().createAsset({ id: randomUUID(), businessId: a.session.business.id, storageKey: "fixture/own.png", mimeType: "image/png", sizeBytes: 80, width: 4, height: 4 });
  assert.equal((await images.POST(call("POST", path, { cookie: a.cookie, body: { imageAssetId: ownAsset.id, capturedAt: new Date().toISOString(), thumbnailUrl: "https://evil.example/image" } }), bound)).status, 400);
  const attached = await body(await images.POST(call("POST", path, { cookie: a.cookie, body: { imageAssetId: ownAsset.id, capturedAt: new Date().toISOString() } }), bound));
  assert.equal(attached.data.productDraftId, draft);
  assert.equal(attached.data.captureId, ownAsset.id);
  assert.equal(attached.data.thumbnailUrl, ownAsset.url);
});

test("call workspace survives actual SQLite close/reopen and retains original owner/draft association", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shopcall-call-persist-")); const path = join(dir, "calls.sqlite");
  let db = new Database(path); db.pragma("foreign_keys=ON");
  try {
    for (const migration of readdirSync("migrations").filter(name => name.endsWith(".sql")).sort()) db.exec(readFileSync(join("migrations", migration), "utf8"));
    const repo = new SqliteRepository(db); const identity = repo.ensureOwnerBusiness("persist@example.com", "Persistent Clay");
    const owner = { ownerId: identity.owner.id, businessId: identity.business.id };
    let store = new CallWorkspaceStore(db); const c = store.createCall(owner, { mode: "create", idempotencyKey: "stable" });
    const draft = store.createDraft(owner, c.id, "one", "White bowl");
    store.patchDraft(owner, c.id, draft.id, { priceMinor: 3200, quantityOnHand: 2 }); store.updateBrief(owner, c.id, { name: "Persistent Clay", style: "Cream and green" });
    db.close(); db = new Database(path); db.pragma("foreign_keys=ON"); store = new CallWorkspaceStore(db);
    assert.equal(store.createCall(owner, { mode: "create", idempotencyKey: "stable" }).id, c.id);
    assert.equal(store.getDraft(owner, c.id, draft.id).fields.quantityOnHand, 2);
    assert.equal(store.getCall(owner, c.id).brief.style, "Cream and green");
    assert.throws(() => store.getCall({ ownerId: randomUUID(), businessId: owner.businessId }, c.id), { code: "NOT_FOUND" });
    const service = new CallWorkspaceService(store, new SqliteRepository(db));
    await assert.rejects(service.proposeProduct(owner, c.id, draft.id), { code: "NOT_READY" });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

function catalogPort(): WorkspaceCatalogRepository {
  const repo = repository();
  return { getBusiness: repo.getBusiness.bind(repo), listProducts: repo.listProducts.bind(repo), getProduct: repo.getProduct.bind(repo), proposeCatalogBatch: repo.proposeCatalogBatch.bind(repo), getCatalogBatch: repo.getCatalogBatch.bind(repo), rejectCatalogBatch: repo.rejectCatalogBatch.bind(repo), getBuildJob: repo.getBuildJob.bind(repo) };
}

test("unknown proposal outcome freezes exact input and replays same key after catalog changes; rejected draft can be corrected", async () => {
  const a = await signIn("proposal-recovery@example.com"); const c = await start(a.cookie);
  const owner = { ownerId: a.session.owner.id, businessId: a.session.business.id };
  const store = callWorkspace().store;
  const draft = store.createDraft(owner, c.id, "recovery", "Blue mug");
  store.patchDraft(owner, c.id, draft.id, { priceMinor: 2400, quantityOnHand: 4 });
  const asset = repository().createAsset({ id: randomUUID(), businessId: owner.businessId, storageKey: "fixture/mug.png", mimeType: "image/png", sizeBytes: 80, width: 4, height: 4 });
  store.attachImage(owner, c.id, draft.id, asset.id, new Date().toISOString());
  const port = catalogPort(); let first = true; let createdId: string | undefined;
  const propose = port.proposeCatalogBatch;
  port.proposeCatalogBatch = async (businessId, input) => {
    const result = await propose(businessId, input); createdId = result.id;
    if (first) { first = false; throw new Error("simulated process interruption after committed proposal"); }
    return result;
  };
  const service = new CallWorkspaceService(store, port);
  await assert.rejects(service.proposeProduct(owner, c.id, draft.id), /simulated process/);
  assert.throws(() => store.patchDraft(owner, c.id, draft.id, { priceMinor: 2000 }), { code: "CONFLICT" });
  // Catalog revision can advance while recovery is pending. The frozen request
  // must retain the original revision to hit the same existing dedupe record.
  await createAndApprove(a.cookie, { type: "create_product", product: { name: "Other item", priceCents: 100, inventoryCount: 1 } });
  const recovered = await service.proposeProduct(owner, c.id, draft.id);
  assert.equal(recovered.id, createdId);
  assert.equal(store.getDraft(owner, c.id, draft.id).proposalId, createdId);
  await repository().rejectCatalogBatch(owner.businessId, recovered.id);
  const edited = await service.updateDraft(owner, c.id, draft.id, { priceMinor: 2000 });
  assert.equal(edited.draft.proposalId, null);
  const replacement = await service.proposeProduct(owner, c.id, draft.id);
  assert.notEqual(replacement.id, recovered.id);
  assert.equal(replacement.changes[0].type, "create_product");
  const review = repository().issueCatalogBatchConfirmation(owner.businessId, replacement.id);
  await repository().approveCatalogBatch(owner.businessId, replacement.id, { confirmationToken: review.confirmationToken, idempotencyKey: "owner-explicit-click" });
  assert.equal((await repository().listProducts(owner.businessId)).find(product => product.name === "Blue mug")!.priceCents, 2000);
});

test("editing while proposal snapshot is being prepared rejects stale revision before creating any proposal", async () => {
  const a = await signIn("proposal-race@example.com"); const c = await start(a.cookie);
  const owner = { ownerId: a.session.owner.id, businessId: a.session.business.id };
  const store = callWorkspace().store; const draft = store.createDraft(owner, c.id, "race", "Mug");
  store.patchDraft(owner, c.id, draft.id, { priceMinor: 2400, quantityOnHand: 1 });
  const asset = repository().createAsset({ id: randomUUID(), businessId: owner.businessId, storageKey: "fixture/race.png", mimeType: "image/png", sizeBytes: 80, width: 4, height: 4 });
  store.attachImage(owner, c.id, draft.id, asset.id, new Date().toISOString());
  const port = catalogPort(); const getBusiness = port.getBusiness; let proposals = 0;
  port.getBusiness = async id => { store.patchDraft(owner, c.id, draft.id, { title: "Corrected bowl" }); return getBusiness(id); };
  port.proposeCatalogBatch = async () => { proposals++; throw new Error("must not be called"); };
  await assert.rejects(new CallWorkspaceService(store, port).proposeProduct(owner, c.id, draft.id), { code: "STALE_REVISION" });
  assert.equal(proposals, 0);
  assert.equal(store.getDraft(owner, c.id, draft.id).proposalRevision, null);
});
