import test from "node:test";
import assert from "node:assert/strict";
import { AutomaticStorefrontTaskObserver, ConfiguredPreviewLocator, createStorefrontPlan, type PreviewInspector, type TaskEvidence } from "../../src/integrations/orchestrator";
import type { BuildRun } from "../../src/integrations/publication/workflow";

const now = () => new Date("2026-11-20T22:00:00Z");
const plan = createStorefrontPlan({ businessId: "7138d322-3d2b-4491-a28b-107d006e7245", businessName: "Juniper", publicCatalogUrl: "https://api.shopcall.example/catalog", catalogRevision: 3, approvedDesignBrief: "Warm cream and green." });
function run(): BuildRun {
  return { id: "run-1", approval: { ownerUserId: "owner-1", businessId: plan.brief.businessId, approvalId: "approval-1" }, plan, phase: "awaiting_task", replId: "repl-1", currentTaskId: "design", evidence: [], publicUrl: null, candidateUrl: null, errorCode: null, verificationChecks: [], verificationAttempts: 0, verifiedAt: null, verifiedCatalogRevision: null, verifiedHttpStatus: null, waitingSince: "2026-11-20T21:59:00Z", createdAt: "2026-11-20T21:59:00Z", updatedAt: "2026-11-20T21:59:00Z" };
}
const locator = new ConfiguredPreviewLocator({ "repl-1": "https://preview.replit.app/" }, ["https://preview.replit.app"]);

test("unknown or private preview cannot be promoted from model prose", async () => {
  assert.equal(await locator.locate("unknown-app"), null);
  const unsafe = new ConfiguredPreviewLocator({ "repl-1": "https://127.0.0.1/" }, ["https://127.0.0.1"]);
  await assert.rejects(() => unsafe.locate("repl-1"));
  let called = false;
  const inspector: PreviewInspector = { async inspect() { called = true; throw new Error("unreachable"); } };
  const missing = new AutomaticStorefrontTaskObserver(new ConfiguredPreviewLocator({}, []), inspector, now);
  assert.deepEqual(await missing.observe(run(), plan.tasks[0]), { state: "blocked", code: "REPLIT_PREVIEW_UNAVAILABLE" });
  assert.equal(called, false);
});

test("observer emits only actually inspected task checks and waits for missing evidence", async () => {
  let checks = ["approved-style-reference"];
  const inspector: PreviewInspector = { async inspect() { return { observedChecks: checks, observedAt: now().toISOString(), artifactRef: "https://preview.replit.app/" }; } };
  const observer = new AutomaticStorefrontTaskObserver(locator, inspector, now);
  assert.deepEqual(await observer.observe(run(), plan.tasks[0]), { state: "pending" });
  checks = [...plan.tasks[0].acceptanceCriteria, "unrelated-check"];
  const result = await observer.observe(run(), plan.tasks[0]);
  assert.equal(result.state, "passed");
  if (result.state === "passed") {
    assert.equal(result.evidence.source, "browser-check");
    assert.deepEqual(result.evidence.checks, plan.tasks[0].acceptanceCriteria);
    assert.equal(result.evidence.planId, plan.id);
    assert.equal(result.evidence.replId, "repl-1");
  }
});

test("observer cannot skip dependencies even if frontend looks ready", async () => {
  const inspector: PreviewInspector = { async inspect() { return { observedChecks: plan.tasks[1].acceptanceCriteria, observedAt: now().toISOString(), artifactRef: "https://preview.replit.app/" }; } };
  const observer = new AutomaticStorefrontTaskObserver(locator, inspector, now);
  assert.deepEqual(await observer.observe(run(), plan.tasks[1]), { state: "pending" });
  const design: TaskEvidence = { planId: plan.id, taskId: "design", replId: "repl-1", source: "browser-check", observedAt: "2026-11-20T21:59:30Z", outcome: "passed", artifactRef: "https://preview.replit.app/", checks: plan.tasks[0].acceptanceCriteria };
  const state = run();
  state.evidence = [design];
  assert.equal((await observer.observe(state, plan.tasks[1])).state, "passed");
  state.evidence = [{ ...design, replId: "wrong-app" }];
  assert.deepEqual(await observer.observe(state, plan.tasks[1]), { state: "pending" });
});

test("unavailable preview remains pending for bounded workflow timeout and never publishes", async () => {
  const observer = new AutomaticStorefrontTaskObserver(locator, { async inspect() { throw new Error("failed network"); } }, now);
  assert.deepEqual(await observer.observe(run(), plan.tasks[0]), { state: "pending" });
  assert.deepEqual(await observer.observe(run(), plan.tasks[4]), { state: "blocked", code: "TASK_OBSERVER_SCOPE_INVALID" });
});
