import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { SqliteRepository } from "../../src/server/repository";
import { CallWorkspaceStore } from "../../src/integrations/call-workspace/store";
import { CallWorkspaceService } from "../../src/integrations/call-workspace/service";
import { ProductMediaStore } from "../../src/integrations/product-media/store";
import { ProductMediaService, type ProductMediaProvider } from "../../src/integrations/product-media/service";
import type { BlobStore } from "../../src/server/storage";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "shopcall-media-test-"));
  const path = join(directory, "catalog.sqlite"); const db = new Database(path); db.pragma("foreign_keys=ON");
  for (const file of readdirSync("migrations").filter(name => name.endsWith(".sql")).sort()) db.exec(readFileSync(join("migrations", file), "utf8"));
  t.after(async () => { if (db.open) db.close(); await rm(directory, { recursive: true, force: true }); });
  const repo = new SqliteRepository(db); const identity = repo.ensureOwnerBusiness("media-owner@example.com", "Clay Studio");
  const other = repo.ensureOwnerBusiness("other-media@example.com", "Other Studio");
  const owner = { ownerId: identity.owner.id, businessId: identity.business.id };
  const foreign = { ownerId: other.owner.id, businessId: other.business.id };
  const workspace = new CallWorkspaceStore(db); const call = workspace.createCall(owner, { mode: "create", idempotencyKey: randomUUID() });
  const jobs = new ProductMediaStore(db); const blobs = new Map<string, Uint8Array>();
  const storage: BlobStore = { async get(key) { return blobs.get(key) ?? null; }, async put(key, bytes) { if (blobs.has(key)) throw new Error("already exists"); blobs.set(key, new Uint8Array(bytes)); } };
  let time = Date.parse("2026-11-20T20:00:00.000Z"); const now = () => new Date(time); const advance = (ms: number) => { time += ms; };
  const media = new ProductMediaService(jobs, workspace, repo, () => storage, now);
  const calls = new CallWorkspaceService(workspace, repo, media);
  const originalBytes = new Uint8Array(await sharp({ create: { width: 5, height: 5, channels: 3, background: "blue" } }).png().toBuffer());
  const enhancedBytes = new Uint8Array(await sharp({ create: { width: 5, height: 5, channels: 3, background: "white" } }).png().toBuffer());
  async function asset() {
    const id = randomUUID(); const storageKey = `businesses/${owner.businessId}/originals/${id}.png`;
    await storage.put(storageKey, originalBytes, "image/png");
    return repo.createAsset({ id, businessId: owner.businessId, storageKey, mimeType: "image/png", sizeBytes: originalBytes.byteLength, width: 5, height: 5 });
  }
  async function capture(title?: string, callId = call.id) {
    const draft = workspace.createDraft(owner, callId, randomUUID(), title);
    workspace.patchDraft(owner, callId, draft.id, { priceMinor: 2400, quantityOnHand: 4 });
    const original = await asset();
    const attached = await calls.attachImage(owner, callId, draft.id, original, now().toISOString());
    return { draftId: draft.id, original, attached, job: media.getForDraft(owner, callId, draft.id).job! };
  }
  const counts = { analyze: 0, enhance: 0 };
  const provider: ProductMediaProvider = {
    async analyze(input) { counts.analyze++; assert.ok(!("priceMinor" in input)); assert.ok(!("quantityOnHand" in input)); return { title: "Blue ceramic mug", description: "Blue mug with a rounded body and loop handle.", model: "mock-vision" }; },
    async enhance() { counts.enhance++; return { bytes: enhancedBytes, mimeType: "image/png", model: "mock-image-edit" }; },
  };
  return { db, path, repo, owner, foreign, workspace, call, jobs, blobs, storage, media, calls, now, advance, asset, capture, originalBytes, enhancedBytes, provider, counts };
}

test("capture autoqueues durable media immediately, results remain suggestions until owner chooses enhanced variant", async t => {
  const f = await fixture(t); const captured = await f.capture();
  assert.equal(captured.attached.media !== undefined, true);
  assert.equal(captured.job.analysisStatus, "queued"); assert.equal(f.counts.analyze, 0);
  assert.equal(f.media.enqueueForDraft(f.owner, f.call.id, captured.draftId).job.id, captured.job.id);
  await f.media.processNext(f.provider);
  const job = f.media.getForDraft(f.owner, f.call.id, captured.draftId).job!;
  assert.equal(job.analysisStatus, "ready"); assert.equal(job.enhancementStatus, "ready");
  assert.equal(job.evidence.analysisModel, "mock-vision"); assert.equal(job.evidence.enhancementModel, "mock-image-edit");
  assert.notEqual(job.enhancedAssetId, job.originalAssetId);
  let draft = f.workspace.getDraft(f.owner, f.call.id, captured.draftId);
  assert.equal(draft.fields.title, undefined); assert.equal(draft.fields.description, undefined); assert.equal(draft.imageAssetId, captured.original.id);
  const result = f.media.applyChoice(f.owner, f.call.id, captured.draftId, { jobId: job.id, expectedDraftRevision: draft.revision, applyTitle: true, applyDescription: true, useEnhanced: true });
  assert.equal(result.draft.fields.title, "Blue ceramic mug"); assert.equal(result.draft.fields.priceMinor, 2400); assert.equal(result.draft.fields.quantityOnHand, 4);
  assert.equal(result.draft.imageAssetId, job.enhancedAssetId); assert.equal(result.job.selectedVariant, "enhanced");
  const original = f.repo.getAssetForServing(captured.original.id)!;
  assert.deepEqual(await f.storage.get(original.storageKey), f.originalBytes);
  draft = result.draft;
  const reverted = f.media.applyChoice(f.owner, f.call.id, captured.draftId, { jobId: job.id, expectedDraftRevision: draft.revision, useEnhanced: false });
  assert.equal(reverted.draft.imageAssetId, captured.original.id);
  assert.equal((await f.media.processNext(f.provider)).processed, false);
  assert.deepEqual(f.counts, { analyze: 1, enhance: 1 });
});

test("ordinary price/stock edits preserve suggestions; owner's changed title and stale UI revision cannot be overwritten", async t => {
  const f = await fixture(t); const capture = await f.capture("Owner mug"); await f.media.processNext(f.provider);
  const before = f.workspace.getDraft(f.owner, f.call.id, capture.draftId);
  f.workspace.patchDraft(f.owner, f.call.id, capture.draftId, { priceMinor: 2000, quantityOnHand: 0 });
  assert.throws(() => f.media.applyChoice(f.owner, f.call.id, capture.draftId, { jobId: capture.job.id, expectedDraftRevision: before.revision, applyDescription: true }), { code: "STALE_REVISION" });
  let current = f.workspace.getDraft(f.owner, f.call.id, capture.draftId);
  const description = f.media.applyChoice(f.owner, f.call.id, capture.draftId, { jobId: capture.job.id, expectedDraftRevision: current.revision, applyDescription: true });
  assert.equal(description.draft.fields.priceMinor, 2000); assert.equal(description.draft.fields.quantityOnHand, 0);
  f.workspace.patchDraft(f.owner, f.call.id, capture.draftId, { title: "Owner corrected bowl" });
  current = f.workspace.getDraft(f.owner, f.call.id, capture.draftId);
  assert.throws(() => f.media.applyChoice(f.owner, f.call.id, capture.draftId, { jobId: capture.job.id, expectedDraftRevision: current.revision, applyTitle: true }), { code: "STALE_REVISION" });
  assert.equal(f.workspace.getDraft(f.owner, f.call.id, capture.draftId).fields.title, "Owner corrected bowl");
});

test("job and original asset association are owner-bound; pending proposal blocks hidden media changes", async t => {
  const f = await fixture(t); const capture = await f.capture("Mug"); await f.media.processNext(f.provider);
  assert.throws(() => f.media.getForDraft(f.foreign, f.call.id, capture.draftId), { code: "NOT_FOUND" });
  assert.throws(() => f.media.applyChoice(f.foreign, f.call.id, capture.draftId, { jobId: capture.job.id, expectedDraftRevision: 1, useEnhanced: true }), { code: "NOT_FOUND" });
  const proposal = await f.calls.proposeProduct(f.owner, f.call.id, capture.draftId);
  assert.equal(proposal.status, "pending");
  const draft = f.workspace.getDraft(f.owner, f.call.id, capture.draftId);
  assert.throws(() => f.media.applyChoice(f.owner, f.call.id, capture.draftId, { jobId: capture.job.id, expectedDraftRevision: draft.revision, useEnhanced: true }), { code: "CONFLICT" });
  assert.equal(f.workspace.getDraft(f.owner, f.call.id, capture.draftId).imageAssetId, capture.original.id);
});

test("replaced capture discards late analysis and never enhances or attaches result to another draft", async t => {
  const f = await fixture(t); const first = await f.capture("Mug"); const second = await f.capture("Bowl");
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const provider: ProductMediaProvider = { ...f.provider, async analyze(input) { await wait; return f.provider.analyze(input); } };
  const running = f.media.processNext(provider); await new Promise(resolve => setImmediate(resolve));
  const newPhoto = await f.asset();
  await f.calls.attachImage(f.owner, f.call.id, first.draftId, newPhoto, new Date(f.now().getTime() + 1).toISOString());
  release(); await running;
  assert.equal(f.jobs.get(first.job.id)!.analysisStatus, "stale"); assert.equal(f.counts.enhance, 0);
  assert.equal(f.workspace.getDraft(f.owner, f.call.id, second.draftId).imageAssetId, second.original.id);
  const current = f.workspace.getDraft(f.owner, f.call.id, first.draftId);
  assert.throws(() => f.media.applyChoice(f.owner, f.call.id, first.draftId, { jobId: first.job.id, expectedDraftRevision: current.revision, useEnhanced: false }), { code: "STALE_REVISION" });
});

test("analysis failure remains honest while independent enhancement succeeds; worker never repeats paid stages", async t => {
  const f = await fixture(t); const captured = await f.capture("Mug");
  const failing: ProductMediaProvider = { ...f.provider, async analyze() { f.counts.analyze++; throw new Error("secret-request-api-key"); } };
  await f.media.processNext(failing);
  const result = f.media.getForDraft(f.owner, f.call.id, captured.draftId).job!;
  assert.equal(result.analysisStatus, "failed"); assert.equal(result.enhancementStatus, "ready"); assert.equal(result.suggestedDescription, null);
  assert.ok(!JSON.stringify(result).includes("secret-request-api-key"));
  assert.equal((await f.media.processNext(failing)).processed, false); assert.deepEqual(f.counts, { analyze: 1, enhance: 1 });
});

test("expired uncertain attempt becomes interrupted and is never retried, but unattempted independent stage may run", async t => {
  const f = await fixture(t); const capture = await f.capture("Mug");
  const claimed = f.jobs.claimNext(f.now(), 1000)!;
  f.jobs.patchClaim(claimed.id, claimed.leaseToken!, { analysisStatus: "running", analysisStartedAt: f.now().toISOString() }, f.now());
  f.advance(1001);
  await f.media.processNext(f.provider);
  const result = f.jobs.get(capture.job.id)!;
  assert.equal(result.analysisStatus, "interrupted"); assert.equal(result.enhancementStatus, "ready");
  assert.equal(f.counts.analyze, 0); assert.equal(f.counts.enhance, 1);
  assert.equal((await f.media.processNext(f.provider)).processed, false);
});

test("durable media queue survives actual database restart without duplicating jobs", async t => {
  const f = await fixture(t); const capture = await f.capture("Mug"); f.db.close();
  const db = new Database(f.path); db.pragma("foreign_keys=ON");
  try {
    const service = new ProductMediaService(new ProductMediaStore(db), new CallWorkspaceStore(db), new SqliteRepository(db), () => f.storage, f.now);
    assert.equal(service.getForDraft(f.owner, f.call.id, capture.draftId).job!.id, capture.job.id);
    assert.equal(service.enqueueForDraft(f.owner, f.call.id, capture.draftId).job.id, capture.job.id);
    await service.processNext(f.provider);
    assert.equal(service.getForDraft(f.owner, f.call.id, capture.draftId).job!.enhancementStatus, "ready");
  } finally { db.close(); }
});

test("auto-generation caps eight new originals per call and thirty per business per UTC day without blocking original uploads", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) assert.equal((await f.capture(`Product ${i}`)).job.analysisStatus, "queued");
  const limited = await f.capture("Ninth product");
  assert.equal(limited.job.errorCode, "MEDIA_LIMIT_REACHED"); assert.equal(limited.job.analysisStatus, "failed");
  assert.equal(f.workspace.getDraft(f.owner, f.call.id, limited.draftId).imageAssetId, limited.original.id);
  for (let group = 0; group < 3; group++) {
    const next = f.workspace.createCall(f.owner, { mode: "create", idempotencyKey: randomUUID() });
    for (let i = 0; i < 8; i++) await f.capture(`Other ${group}-${i}`, next.id);
  }
  const next = f.workspace.createCall(f.owner, { mode: "create", idempotencyKey: randomUUID() });
  assert.equal((await f.capture("Daily cap", next.id)).job.errorCode, "MEDIA_LIMIT_REACHED");
  assert.deepEqual(f.counts, { analyze: 0, enhance: 0 });
});
