import test from "node:test";
import assert from "node:assert/strict";
import { mediaJobMatchesDraft, mediaJobIsRunning, mediaStageLabel, type MediaJobView } from "../../src/features/call/media";
import { createApiClient } from "../../src/features/call/api";
const draftA = "55555555-5555-4555-8555-555555555555";
const draftB = "66666666-6666-4666-8666-666666666666";
function job(): MediaJobView {
  return { id: "job-a", productDraftId: draftA, originalAssetId: "original-a", originalUrl: "/original", enhancedAssetId: "enhanced-a", enhancedUrl: "/enhanced", sourceDraftRevision: 2, currentDraftRevision: 2, analysisStatus: "ready", enhancementStatus: "ready", selectedVariant: "original", suggestedTitle: "Blue mug", suggestedDescription: "A blue mug with a loop handle.", titleApplied: false, descriptionApplied: false, errorCode: null, evidence: { analysisModel: "fixture-vision", enhancementModel: "fixture-image", analysisStartedAt: null, analysisCompletedAt: null, enhancementStartedAt: null, enhancementCompletedAt: null }, createdAt: "2026-11-20T22:00:00Z", updatedAt: "2026-11-20T22:00:00Z" };
}

test("media result stays bound to its captured draft even when active product changes", () => {
  const result = job();
  assert.equal(mediaJobMatchesDraft(result, { id: draftA, imageAssetId: "original-a" }), true);
  assert.equal(mediaJobMatchesDraft(result, { id: draftB, imageAssetId: "original-a" }), false);
  assert.equal(mediaJobMatchesDraft(result, { id: draftA, imageAssetId: "retaken-photo" }), false);
});

test("owner-selected enhancement retains original identity; missing enhanced asset is never valid", () => {
  const result = { ...job(), selectedVariant: "enhanced" as const };
  assert.equal(mediaJobMatchesDraft(result, { id: draftA, imageAssetId: "enhanced-a" }), true);
  assert.equal(result.originalAssetId, "original-a");
  assert.equal(mediaJobMatchesDraft({ ...result, enhancedAssetId: null }, { id: draftA, imageAssetId: null }), false);
});

test("polling and copy reflect actual running/failed stages without fabricated completion", () => {
  assert.equal(mediaJobIsRunning({ ...job(), enhancementStatus: "queued" }), true);
  assert.equal(mediaJobIsRunning({ ...job(), analysisStatus: "running" }), true);
  assert.equal(mediaJobIsRunning({ ...job(), analysisStatus: "failed", enhancementStatus: "interrupted" }), false);
  assert.equal(mediaStageLabel("running", "analysis"), "Analyzing photo");
  assert.equal(mediaStageLabel("running", "enhancement"), "Enhancing photo");
  assert.equal(mediaStageLabel("failed", "enhancement"), "Enhancement failed");
});

test("media API uses stable call/draft identity and explicit owner flags without price or stock changes", async () => {
  const seen: { method: string; path: string; body: unknown }[] = [];
  const api = createApiClient((async (input, init) => {
    seen.push({ method: init?.method ?? "GET", path: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    return Response.json({ ok: true, data: { job: job() } });
  }) as typeof fetch);
  await api.getDraftMedia("call-a", draftA);
  await api.chooseDraftMedia("call-a", draftA, { jobId: "job-a", expectedDraftRevision: 2, applyTitle: true, applyDescription: true });
  assert.equal(seen[0].path, `/api/calls/call-a/drafts/${draftA}/media`);
  assert.deepEqual(seen[1], { method: "POST", path: `/api/calls/call-a/drafts/${draftA}/media/choice`, body: { jobId: "job-a", expectedDraftRevision: 2, applyTitle: true, applyDescription: true } });
  assert.equal(JSON.stringify(seen[1].body).includes("price"), false);
  assert.equal(JSON.stringify(seen[1].body).includes("stock"), false);
});
