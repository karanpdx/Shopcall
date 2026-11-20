import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient, normalizeBuildJob, summarizeBatch, flattenWorkingDraft, type WorkspaceDraft } from "../../src/features/call/api";
import type { BuildJob } from "../../src/contracts/api";
import type { CatalogBatch } from "../../src/integrations/catalog-batches/types";
const CALL = "33333333-3333-4333-8333-333333333333";
const DRAFT = "55555555-5555-4555-8555-555555555555";

test("call creation supplies required idempotency key and consumes actual workspace envelope", async () => {
  let body: unknown;
  const api = createApiClient((async (_input, init) => { body = JSON.parse(String(init?.body)); return Response.json({ ok: true, data: { call: { id: CALL }, drafts: [] } }); }) as typeof fetch);
  const response = await api.createCall("create", "start-1");
  assert.deepEqual(body, { mode: "create", idempotencyKey: "start-1" });
  assert.equal(response.ok && response.data.call.id, CALL);
});

test("upload uses actual multipart file path and stable call/draft IDs with captured timestamp", async () => {
  let path = ""; let sent: RequestInit | undefined;
  const api = createApiClient((async (input, init) => { path = String(input); sent = init; return Response.json({ ok: true, data: { captureId: "asset", productDraftId: DRAFT, thumbnailUrl: "/image" } }); }) as typeof fetch);
  const uploaded = await api.uploadDraftImage(CALL, DRAFT, new Blob(["photo"], { type: "image/jpeg" }), "2026-11-20T22:00:00Z");
  assert.equal(path, `/api/calls/${CALL}/drafts/${DRAFT}/images`);
  assert.equal(sent?.credentials, "same-origin");
  assert.equal(new Headers(sent?.headers).get("x-captured-at"), "2026-11-20T22:00:00Z");
  assert.ok(sent?.body instanceof FormData);
  assert.equal((sent.body as FormData).has("file"), true);
  assert.equal((sent.body as FormData).has("image"), false);
  assert.equal(new Headers(sent?.headers).has("content-type"), false);
  assert.equal(uploaded.ok && uploaded.data.thumbnailUrl, "/api/assets/asset");
});

test("owner confirmation uses review-issued token under actual backend field name", async () => {
  let body: unknown;
  const api = createApiClient((async (_input, init) => { body = JSON.parse(String(init?.body)); return Response.json({ ok: true, data: { status: "approved" } }); }) as typeof fetch);
  await api.confirmCatalogProposal("proposal", "owner-only-token", "apply-1");
  assert.deepEqual(body, { confirmationToken: "owner-only-token", idempotencyKey: "apply-1" });
});

test("combined call review prepares one batch without applying or requesting an owner nonce", async () => {
  const seen: { path: string; body: unknown }[] = [];
  const api = createApiClient((async (input, init) => {
    seen.push({ path: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, data: { proposal: { id: "all-products", status: "pending" }, business: { name: "Juniper", contactEmail: "owner@example.com", description: null }, productDraftIds: [DRAFT], incompleteDraftIds: [], noCatalogChanges: false } });
  }) as typeof fetch);
  const response = await api.proposeCallReview(CALL, { name: "Juniper", contactEmail: "owner@example.com", idempotencyKey: "one-review" });
  assert.deepEqual(seen, [{ path: `/api/calls/${CALL}/review`, body: { name: "Juniper", contactEmail: "owner@example.com", idempotencyKey: "one-review" } }]);
  assert.equal(response.ok && response.data.proposal?.status, "pending");
  assert.equal(seen.some(request => /\/confirm$|proposals.*\/review$/.test(request.path)), false);
});

test("job display never exposes candidate URL before both build and publication complete", () => {
  const job: BuildJob = { id: "job", businessId: "business", provider: "replit", providerJobId: "repl", buildStatus: "completed", publicationStatus: "pending", publicUrl: "https://candidate.replit.app/", errorMessage: null, createdAt: "now", updatedAt: "now" };
  assert.equal(normalizeBuildJob(job).publicUrl, null);
  assert.equal(normalizeBuildJob({ ...job, publicationStatus: "completed" }).phase, "ready");
  assert.equal(normalizeBuildJob({ ...job, publicationStatus: "failed" }).phase, "failed");
  const blocked = normalizeBuildJob({ ...job, buildStatus: "running", workflow: { job: null, task: { id: "design", role: "Storefront UI designer" }, blocked: true, requiresReconciliation: true } });
  assert.equal(blocked.phase, "failed");
  assert.equal(blocked.requiresAttention, true);
  assert.equal(blocked.publicUrl, null);
  assert.deepEqual(blocked.backendStatus, { buildStatus: "running", publicationStatus: "pending" });
  assert.deepEqual(blocked.task, { id: "design", role: "Storefront UI designer" });
});

test("private draft thumbnails remain on owner origin even when public backend uses a tunnel", () => {
  const draft = { id: DRAFT, fields: { title: "Mug" }, imageAssetId: "asset-1", imageUrl: "https://public-tunnel.example/api/assets/asset-1" } as WorkspaceDraft;
  assert.equal(flattenWorkingDraft(draft).imageUrl, "/api/assets/asset-1");
});

test("proposal summary carries token only when issued to owner UI", () => {
  const batch = { id: "batch", expiresAt: "later", expectedCatalogRevision: 2, changes: [{ type: "update_price", productId: DRAFT, priceCents: 2000, expectedRevision: 1 }], summary: ["Blue mug: price USD 24.00 → 20.00"] } as CatalogBatch;
  assert.equal(summarizeBatch(batch).approvalNonce, "");
  assert.equal(summarizeBatch(batch, "secret").approvalNonce, "secret");
  assert.deepEqual(summarizeBatch(batch).items[0], { label: "Blue mug", before: "price USD 24.00", after: "20.00" });
});

test("HTTP error cannot become successful even if malformed backend claims ok", async () => {
  const api = createApiClient((async () => Response.json({ ok: true, data: {} }, { status: 500 })) as typeof fetch);
  assert.equal((await api.getJob("job")).ok, false);
});
