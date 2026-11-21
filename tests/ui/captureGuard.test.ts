import test from "node:test";
import assert from "node:assert/strict";
import { createDraftCaptureGuard, type DraftCaptureResult } from "../../src/features/call/captureGuard";
import { photoProgressLabel } from "../../src/features/call/components/PhotoProgress";
import type { MediaJobView } from "../../src/features/call/media";

test("model, automatic and manual requests share one in-flight still/upload for a draft", async () => {
  let calls = 0;
  let complete!: (result: DraftCaptureResult) => void;
  const guard = createDraftCaptureGuard(async () => { calls++; return new Promise<DraftCaptureResult>(resolve => { complete = resolve; }); }, () => null);
  const auto = guard.run("draft-a", true);
  const model = guard.run("draft-a", true);
  const manual = guard.run("draft-a", false);
  assert.equal(auto, model); assert.equal(model, manual);
  await Promise.resolve(); assert.equal(calls, 1);
  complete({ ok: true, captureId: "asset-a", thumbnailUrl: "/api/assets/asset-a" });
  await Promise.all([auto, model, manual]);
  const reused = await guard.run("draft-a", true);
  assert.equal(reused.ok && reused.captureId, "asset-a");
  assert.equal(reused.ok && reused.reused, true);
  assert.equal(calls, 1, "React state lag must not trigger another photo generation job.");
});

test("explicit Retake still captures after completion; drafts cannot reuse another item's image", async () => {
  const calls: string[] = [];
  const guard = createDraftCaptureGuard(async id => { calls.push(id); return { ok: true, captureId: `${id}-${calls.length}`, thumbnailUrl: "/image" }; }, () => null);
  const first = await guard.run("a", true);
  const retake = await guard.run("a", false);
  const other = await guard.run("b", true);
  assert.deepEqual(calls, ["a", "a", "b"]);
  assert.notDeepEqual(first, retake);
  assert.equal(other.ok && other.captureId, "b-3");
});

test("existing selected photo is reused without camera access; failed work can be manually retried", async () => {
  let calls = 0;
  const existing = createDraftCaptureGuard(async () => { throw new Error("Camera must not open"); }, () => ({ ok: true, captureId: "selected", thumbnailUrl: "/selected" }));
  assert.equal((await existing.run("a", true)).ok, true);
  const retry = createDraftCaptureGuard(async () => { calls++; return calls === 1 ? { ok: false, error: "Camera off" } : { ok: true, captureId: "saved", thumbnailUrl: "/saved" }; }, () => null);
  assert.equal((await retry.run("a")).ok, false);
  assert.equal((await retry.run("a")).ok, true);
});

test("main photo progress only reports real stages and requires a generated asset for enhanced preview", () => {
  const job = { analysisStatus: "running", enhancementStatus: "queued", enhancedAssetId: null } as MediaJobView;
  assert.equal(photoProgressLabel(job, false, false), "Analyzing photo…");
  assert.equal(photoProgressLabel({ ...job, analysisStatus: "ready", enhancementStatus: "running" }, false, false), "Enhancing photo…");
  assert.equal(photoProgressLabel({ ...job, enhancementStatus: "ready", enhancedAssetId: "generated" }, false, false), "Enhanced preview ready");
  assert.notEqual(photoProgressLabel({ ...job, enhancementStatus: "ready" }, false, false), "Enhanced preview ready");
});
