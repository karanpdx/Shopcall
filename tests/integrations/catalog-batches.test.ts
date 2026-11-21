import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { body, call, createAndApprove, params, signIn } from "../helpers/backend";
import * as calls from "../../src/app/api/calls/route";
import * as proposals from "../../src/app/api/catalog/proposals/route";
import * as proposalById from "../../src/app/api/catalog/proposals/[id]/route";
import * as review from "../../src/app/api/catalog/proposals/[id]/review/route";
import * as confirm from "../../src/app/api/catalog/proposals/[id]/confirm/route";
import * as reject from "../../src/app/api/catalog/proposals/[id]/reject/route";
import { repository } from "../../src/server/repository";

async function setup() {
  const a = await signIn(`${randomUUID()}@example.com`);
  const started = await body(await calls.POST(call("POST", "/api/calls", { cookie: a.cookie, body: { mode: "update", idempotencyKey: randomUUID() } })));
  const mug = await createAndApprove(a.cookie, { type: "create_product", product: { name: "Blue mug", priceCents: 2400, inventoryCount: 4 } });
  const vase = await createAndApprove(a.cookie, { type: "create_product", product: { name: "Tall vase", priceCents: 4500, inventoryCount: 1 } });
  const business = (await repository().getBusiness(a.session.business.id))!;
  const input = { callId: started.data.call.id, expectedCatalogRevision: business.catalogRevision, idempotencyKey: randomUUID(), changes: [
    { type: "update_price", productId: mug.data.product.id, priceCents: 2000, expectedRevision: 1 },
    { type: "update_stock", productId: vase.data.product.id, inventoryCount: 0, expectedRevision: 1 },
  ] };
  const proposed = await body(await proposals.POST(call("POST", "/api/catalog/proposals", { cookie: a.cookie, body: input })));
  assert.equal(proposed.ok, true);
  return { ...a, mug: mug.data.product, vase: vase.data.product, input, batch: proposed.data };
}

test("owner review nonce gates atomic two-product approval; retries cannot double apply", async () => {
  const a = await setup();
  const id = a.batch.id;
  const details = await body(await proposalById.GET(call("GET", `/api/catalog/proposals/${id}`, { cookie: a.cookie }), params({ id })));
  assert.equal(JSON.stringify(details).includes("confirmationToken"), false);
  const fake = await confirm.POST(call("POST", `/api/catalog/proposals/${id}/confirm`, { cookie: a.cookie, body: { confirmationToken: "forged".repeat(8), idempotencyKey: "apply" } }), params({ id }));
  assert.equal(fake.status, 403);
  assert.equal((await repository().getProduct(a.session.business.id, a.mug.id))!.priceCents, 2400);
  const reviewed = await body(await review.POST(call("POST", `/api/catalog/proposals/${id}/review`, { cookie: a.cookie }), params({ id })));
  const input = { confirmationToken: reviewed.data.confirmationToken, idempotencyKey: "explicit-owner-click" };
  assert.equal((await confirm.POST(call("POST", `/api/catalog/proposals/${id}/confirm`, { cookie: a.cookie, body: input }), params({ id }))).status, 200);
  const first = await repository().getProduct(a.session.business.id, a.mug.id);
  assert.equal(first!.priceCents, 2000);
  assert.equal((await repository().getProduct(a.session.business.id, a.vase.id))!.soldOut, true);
  await confirm.POST(call("POST", `/api/catalog/proposals/${id}/confirm`, { cookie: a.cookie, body: input }), params({ id }));
  assert.equal((await repository().getProduct(a.session.business.id, a.mug.id))!.revision, first!.revision);
});

test("stale catalog rejects entire batch and leaves every product untouched", async () => {
  const a = await setup();
  const reviewed = repository().issueCatalogBatchConfirmation(a.session.business.id, a.batch.id);
  await createAndApprove(a.cookie, { type: "create_product", product: { name: "Other", priceCents: 100, inventoryCount: 1 } });
  const response = await confirm.POST(call("POST", `/api/catalog/proposals/${a.batch.id}/confirm`, { cookie: a.cookie, body: { confirmationToken: reviewed.confirmationToken, idempotencyKey: "apply-stale" } }), params({ id: a.batch.id }));
  assert.equal(response.status, 409);
  assert.equal((await body(response)).error!.code, "STALE_REVISION");
  assert.equal((await repository().getProduct(a.session.business.id, a.mug.id))!.priceCents, 2400);
  assert.equal((await repository().getProduct(a.session.business.id, a.vase.id))!.inventoryCount, 1);
  assert.equal(repository().getCatalogBatch(a.session.business.id, a.batch.id).status, "pending");
});

test("same-product price and stock changes share reviewed base revision and apply together", async () => {
  const a = await setup();
  await repository().rejectCatalogBatch(a.session.business.id, a.batch.id);
  const next = await repository().proposeCatalogBatch(a.session.business.id, { ...a.input, idempotencyKey: randomUUID(), changes: [
    { type: "update_price", productId: a.mug.id, priceCents: 1900, expectedRevision: 1 },
    { type: "update_stock", productId: a.mug.id, inventoryCount: 0, expectedRevision: 1 },
  ] });
  const nonce = repository().issueCatalogBatchConfirmation(a.session.business.id, next.id).confirmationToken;
  await repository().approveCatalogBatch(a.session.business.id, next.id, { confirmationToken: nonce, idempotencyKey: "same-product" });
  const updated = (await repository().getProduct(a.session.business.id, a.mug.id))!;
  assert.equal(updated.priceCents, 1900);
  assert.equal(updated.inventoryCount, 0);
});

test("second invalid mutation rolls back first mutation, approvals and catalog revision", async () => {
  const a = await setup();
  const revision = (await repository().getBusiness(a.session.business.id))!.catalogRevision;
  const next = await repository().proposeCatalogBatch(a.session.business.id, { ...a.input, idempotencyKey: randomUUID(), changes: [
    { type: "adjust_stock", productId: a.vase.id, delta: -1, expectedRevision: 1 },
    { type: "adjust_stock", productId: a.vase.id, delta: -1, expectedRevision: 1 },
  ] });
  const confirmationToken = repository().issueCatalogBatchConfirmation(a.session.business.id, next.id).confirmationToken;
  await assert.rejects(repository().approveCatalogBatch(a.session.business.id, next.id, { confirmationToken, idempotencyKey: "invalid-stock" }), { code: "CONFLICT" });
  assert.equal((await repository().getProduct(a.session.business.id, a.vase.id))!.inventoryCount, 1);
  assert.equal((await repository().getBusiness(a.session.business.id))!.catalogRevision, revision);
  for (const id of next.draftIds) assert.equal((await repository().getDraft(a.session.business.id, id))!.status, "pending");
});

test("foreign owner and cross-origin approval are rejected; rejected proposal cannot apply", async () => {
  const a = await setup();
  const other = await signIn(`${randomUUID()}@example.com`);
  const id = a.batch.id;
  assert.equal((await review.POST(call("POST", `/api/catalog/proposals/${id}/review`, { cookie: other.cookie }), params({ id }))).status, 404);
  assert.equal((await review.POST(call("POST", `/api/catalog/proposals/${id}/review`, { cookie: a.cookie, origin: "https://evil.example" }), params({ id }))).status, 403);
  const token = repository().issueCatalogBatchConfirmation(a.session.business.id, id).confirmationToken;
  await reject.POST(call("POST", `/api/catalog/proposals/${id}/reject`, { cookie: a.cookie }), params({ id }));
  await assert.rejects(repository().approveCatalogBatch(a.session.business.id, id, { confirmationToken: token, idempotencyKey: "after-reject" }), { code: "CONFLICT" });
});
