import test from "node:test";
import assert from "node:assert/strict";
import { AutomaticStorefrontTaskObserver, ConfiguredPreviewLocator, createStorefrontPlan, type PreviewInspector, type TaskEvidence } from "../../src/integrations/orchestrator";
import type { BuildRun } from "../../src/integrations/publication/workflow";

const now = () => new Date("2026-11-20T22:00:00Z");
const plan = createStorefrontPlan({ businessId: "7138d322-3d2b-4491-a28b-107d006e7245", businessName: "Juniper", publicCatalogUrl: "https://api.shopcall.example/catalog", catalogRevision: 3, approvedDesignBrief: "Warm cream and green." });
const qaTask = plan.tasks.find(task => task.id === "qa")!;
function preflight(): TaskEvidence[] {
  const artifacts: TaskEvidence[] = plan.tasks.slice(0, 3).map((task, index) => ({ planId: plan.id, taskId: task.id, replId: "repl-1", source: "artifact-review", observedAt: `2026-11-20T21:5${index}:00Z`, outcome: "passed", artifactRef: `replit:source/${task.id}`, checks: task.acceptanceCriteria }));
  return [...artifacts, { planId: plan.id, taskId: "deploy", replId: "repl-1", source: "provider-publish-status", observedAt: "2026-11-20T21:59:00Z", outcome: "passed", artifactRef: "replit:published", checks: ["provider-published"] }];
}
function run(): BuildRun {
  return { id: "run-1", approval: { ownerUserId: "owner-1", businessId: plan.brief.businessId, approvalId: "approval-1" }, plan, phase: "verifying", replId: "repl-1", currentTaskId: "qa", evidence: preflight(), publicUrl: null, candidateUrl: "https://public.replit.app/", errorCode: null, verificationChecks: [], verificationAttempts: 0, verifiedAt: null, verifiedCatalogRevision: null, verifiedHttpStatus: null, waitingSince: "2026-11-20T21:59:00Z", createdAt: "2026-11-20T21:49:00Z", updatedAt: "2026-11-20T21:59:00Z" };
}
const locator = new ConfiguredPreviewLocator({ "repl-1": "https://protected-preview.replit.app/" }, ["https://protected-preview.replit.app"]);

test("public QA never depends on bypassing protected native preview", async () => {
  assert.equal(await locator.locate("unknown-app"), null);
  const unsafe = new ConfiguredPreviewLocator({ "repl-1": "https://127.0.0.1/" }, ["https://127.0.0.1"]);
  await assert.rejects(() => unsafe.locate("repl-1"));
  let called = false;
  const inspector: PreviewInspector = { async inspect() { called = true; throw new Error("unreachable"); } };
  const observer = new AutomaticStorefrontTaskObserver(locator, inspector, now);
  const missing = run(); missing.candidateUrl = null;
  assert.deepEqual(await observer.observe(missing, qaTask), { state: "pending" });
  assert.equal(called, false);
});

test("observer inspects provider-published candidate and emits only observed QA criteria", async () => {
  let checks = ["approved-style-reference"];
  let observedUrl = "";
  const inspector: PreviewInspector = { async inspect(url) { observedUrl = url; return { observedChecks: checks, observedAt: now().toISOString(), artifactRef: url }; } };
  const observer = new AutomaticStorefrontTaskObserver(locator, inspector, now);
  assert.deepEqual(await observer.observe(run(), qaTask), { state: "pending" });
  checks = [...qaTask.acceptanceCriteria, "unrelated-check"];
  const result = await observer.observe(run(), qaTask);
  assert.equal(observedUrl, "https://public.replit.app/");
  assert.equal(result.state, "passed");
  if (result.state === "passed") {
    assert.equal(result.evidence.source, "browser-check");
    assert.deepEqual(result.evidence.checks, qaTask.acceptanceCriteria);
    assert.equal(result.evidence.planId, plan.id);
  }
});

test("QA cannot skip actual publication or static artifact preflight", async () => {
  const inspector: PreviewInspector = { async inspect(url) { return { observedChecks: qaTask.acceptanceCriteria, observedAt: now().toISOString(), artifactRef: url }; } };
  const observer = new AutomaticStorefrontTaskObserver(locator, inspector, now);
  const state = run(); state.evidence = [];
  assert.deepEqual(await observer.observe(state, qaTask), { state: "pending" });
  state.evidence = preflight().slice(0, 3);
  assert.deepEqual(await observer.observe(state, qaTask), { state: "pending" });
  state.evidence = preflight();
  assert.equal((await observer.observe(state, qaTask)).state, "passed");
});

test("browser observer rejects prepublication task use and retries temporary public failures", async () => {
  const observer = new AutomaticStorefrontTaskObserver(locator, { async inspect() { throw new Error("failed network"); } }, now);
  assert.deepEqual(await observer.observe(run(), qaTask), { state: "pending" });
  assert.deepEqual(await observer.observe(run(), plan.tasks[0]), { state: "blocked", code: "TASK_OBSERVER_SCOPE_INVALID" });
  const early = run(); early.phase = "awaiting_task";
  assert.deepEqual(await observer.observe(early, qaTask), { state: "blocked", code: "TASK_OBSERVER_SCOPE_INVALID" });
});
