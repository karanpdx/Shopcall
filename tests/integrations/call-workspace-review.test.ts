import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { body, call, createAndApprove, ORIGIN, params, signIn } from "../helpers/backend";
import * as review from "../../src/app/api/calls/[id]/review/route";
import { repository } from "../../src/server/repository";
import { callWorkspace } from "../../src/integrations/call-workspace/runtime";
import { CallWorkspaceService, type WorkspaceCatalogRepository } from "../../src/integrations/call-workspace/service";
process.env.APP_BASE_URL = ORIGIN;

async function fixture(email: string) {
  const a = await signIn(email); const workspace = callWorkspace();
  const owner = { ownerId: a.session.owner.id as string, businessId: a.session.business.id as string };
  const c = workspace.store.createCall(owner, { mode: "create", idempotencyKey: randomUUID() });
  return { ...a, workspace, owner, c };
}
function complete(f: Awaited<ReturnType<typeof fixture>>, name: string) {
  const draft = f.workspace.store.createDraft(f.owner, f.c.id, randomUUID(), name);
  f.workspace.store.patchDraft(f.owner, f.c.id, draft.id, { priceMinor: 2400, quantityOnHand: 4 });
  const asset = repository().createAsset({ id: randomUUID(), businessId: f.owner.businessId, storageKey: `fixture/${draft.id}.png`, mimeType: "image/png", sizeBytes: 80, width: 4, height: 4 });
  f.workspace.store.attachImage(f.owner, f.c.id, draft.id, asset.id, new Date().toISOString());
  return draft.id;
}

test("ended call's two products and staged business form ONE atomic review; individual pending preview cannot duplicate", async () => {
  const f = await fixture("combined-review@example.com");
  const first = complete(f, "Blue mug"); const second = complete(f, "White bowl");
  const incomplete = f.workspace.store.createDraft(f.owner, f.c.id, "incomplete", "Unfinished vase");
  const individual = await f.workspace.proposeProduct(f.owner, f.c.id, first);
  f.workspace.store.updateBrief(f.owner, f.c.id, { description: "Handmade ceramics" });
  f.workspace.store.endCall(f.owner, f.c.id);
  const input = { name: "Combined Clay", contactEmail: "contact@example.com", idempotencyKey: "single-owner-review" };
  const response = await review.POST(call("POST", `/api/calls/${f.c.id}/review`, { cookie: f.cookie, body: input }), params({ id: f.c.id }));
  assert.equal(response.status, 200); const data = (await body(response)).data;
  assert.deepEqual(new Set(data.productDraftIds), new Set([first, second]));
  assert.deepEqual(data.incompleteDraftIds, [incomplete.id]);
  assert.equal(data.proposal.changes.filter((change: { type: string }) => change.type === "create_product").length, 2);
  assert.equal(data.proposal.changes.filter((change: { type: string }) => change.type === "update_storefront").length, 1);
  assert.equal(repository().getCatalogBatch(f.owner.businessId, individual.id).status, "rejected");
  assert.equal((await repository().listProducts(f.owner.businessId)).length, 0);
  assert.notEqual((await repository().getBusiness(f.owner.businessId))!.name, "Combined Clay");
  assert.ok(!JSON.stringify(data).includes("confirmationToken"));
  const retry = await f.workspace.prepareCallReview(f.owner, f.c.id, input);
  assert.equal(retry.proposal!.id, data.proposal.id);
  const nonce = repository().issueCatalogBatchConfirmation(f.owner.businessId, data.proposal.id);
  await repository().approveCatalogBatch(f.owner.businessId, data.proposal.id, { confirmationToken: nonce.confirmationToken, idempotencyKey: "one-explicit-publish-click" });
  assert.equal((await repository().listProducts(f.owner.businessId)).length, 2);
  const approvedBusiness = (await repository().getBusiness(f.owner.businessId))!;
  assert.equal(approvedBusiness.name, "Combined Clay"); assert.equal(approvedBusiness.contactEmail, "contact@example.com");
  assert.equal(f.workspace.store.getCall(f.owner, f.c.id).status, "ended");
  assert.equal((await f.workspace.prepareCallReview(f.owner, f.c.id, input)).proposal!.status, "approved");
  assert.equal((await repository().listProducts(f.owner.businessId)).length, 2);
});

test("review never forces microphone restart; no complete products fails saved, unchanged existing catalog needs no second batch", async () => {
  const f = await fixture("combined-empty@example.com"); f.workspace.store.endCall(f.owner, f.c.id);
  const input = { name: "Existing Store", contactEmail: "existing@example.com", idempotencyKey: "first" };
  await assert.rejects(f.workspace.prepareCallReview(f.owner, f.c.id, input), { code: "NOT_READY" });
  assert.equal(f.workspace.store.getCall(f.owner, f.c.id).status, "ended");
  await createAndApprove(f.cookie, { type: "create_product", product: { name: "Existing mug", priceCents: 2400, inventoryCount: 1 } });
  await createAndApprove(f.cookie, { type: "update_storefront", patch: { name: input.name, contactEmail: input.contactEmail } });
  const noChange = await f.workspace.prepareCallReview(f.owner, f.c.id, input);
  assert.equal(noChange.proposal, null); assert.equal(noChange.noCatalogChanges, true);
});

test("combined review preserves frozen input after unknown committed outcome and rejects foreign owner", async () => {
  const f = await fixture("combined-recovery@example.com"); const draftId = complete(f, "Mug");
  const repo = repository(); let failOnce = true; let proposalId: string | undefined;
  const port: WorkspaceCatalogRepository = {
    getBusiness: repo.getBusiness.bind(repo), listProducts: repo.listProducts.bind(repo), getProduct: repo.getProduct.bind(repo), getCatalogBatch: repo.getCatalogBatch.bind(repo), rejectCatalogBatch: repo.rejectCatalogBatch.bind(repo), getBuildJob: repo.getBuildJob.bind(repo),
    async proposeCatalogBatch(businessId, input) { const batch = await repo.proposeCatalogBatch(businessId, input); proposalId = batch.id; if (failOnce) { failOnce = false; throw new Error("simulated interruption"); } return batch; },
  };
  const service = new CallWorkspaceService(f.workspace.store, port);
  const input = { name: "Recovered Clay", contactEmail: "recovered@example.com", idempotencyKey: "recover" };
  await assert.rejects(service.prepareCallReview(f.owner, f.c.id, input), /simulated/);
  assert.throws(() => f.workspace.store.patchDraft(f.owner, f.c.id, draftId, { priceMinor: 1 }), { code: "CONFLICT" });
  const recovered = await service.prepareCallReview(f.owner, f.c.id, input);
  assert.equal(recovered.proposal!.id, proposalId); assert.equal((await repo.listProducts(f.owner.businessId)).length, 0);
  await assert.rejects(service.prepareCallReview(f.owner, f.c.id, { ...input, name: "Different" }), { code: "CONFLICT" });
  const foreign = await fixture("combined-foreign@example.com");
  const denied = await review.POST(call("POST", `/api/calls/${f.c.id}/review`, { cookie: foreign.cookie, body: input }), params({ id: f.c.id }));
  assert.equal(denied.status, 404);
});
