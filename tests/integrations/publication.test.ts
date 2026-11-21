import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FileBuildRunStore } from "../../src/integrations/publication/store";
import { PublicationWorkflow, type ReplitBuildPort, type StorefrontVerifier, type TaskObservation } from "../../src/integrations/publication/workflow";
import { WorkflowPublicationSource, PublicationNotificationWorker } from "../../src/integrations/publication/notifications";
import { toOwnerBuildStatus } from "../../src/integrations/publication/status";
import { createInMemoryNotificationOutbox } from "../../src/integrations/notifications";

const businessId = "f1fa84f0-c846-48ba-9cad-7bf073e906fb";
const brief = { businessId, businessName: "Studio Clay", publicCatalogUrl: "https://catalog.example.com/api/public/stores/clay/catalog", catalogRevision: 2, approvedDesignBrief: "Cream and forest green, warm handmade ceramics." };
const approval = { ownerUserId: "1af3a039-4906-4e2e-978d-e4d166108fd0", businessId, approvalId: "actual-approved-snapshot" };
const now = () => new Date("2026-11-20T23:00:00.000Z");

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "shopcall-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileBuildRunStore(directory);
  const calls = { create: 0, update: 0, publish: 0 };
  const port: ReplitBuildPort = {
    async createApp() { calls.create++; return { replId: "actual-app" }; },
    async updateApp() { calls.update++; },
    async observeTask(run, task): Promise<TaskObservation> {
      return { state: "passed", evidence: { planId: run.plan.id, taskId: task.id, replId: run.replId!, source: "independent-review", observedAt: now().toISOString(), outcome: "passed", artifactRef: "https://preview.example.com", checks: task.acceptanceCriteria } };
    },
    async publishApp() { calls.publish++; },
    async observePublish() { return { state: "ready", publicUrl: "https://studio.replit.app/" }; },
  };
  const verifier: StorefrontVerifier = {
    async verify(url, plan, replId) {
      return { passed: true, catalogRevision: 2, httpStatus: 200, checks: ["anonymous-public-url", "correct-live-business-catalog", "current-product-prices-stock", "usable-original-images", "same-origin-live-catalog-proxy"], evidence: [{ planId: plan.id, taskId: "deploy", replId, source: "browser-check", outcome: "passed", observedAt: now().toISOString(), artifactRef: url, checks: ["anonymous-public-url", "correct-live-business-catalog"] }] };
    },
  };
  const workflow = new PublicationWorkflow(store, { async getApprovedBrief() { return brief; } }, port, verifier, now);
  return { store, port, verifier, workflow, calls };
}

test("ordered specialist tasks use one app and ready requires provider plus public proof", async t => {
  const { workflow, calls } = await fixture(t);
  const runId = randomUUID();
  await workflow.enqueue(runId, approval);
  const phases: string[] = [];
  for (let tick = 0; tick < 7; tick++) phases.push((await workflow.step(runId)).phase);
  assert.deepEqual(phases, ["awaiting_task", "awaiting_task", "awaiting_task", "ready_to_publish", "publishing", "verifying", "ready"]);
  assert.deepEqual(calls, { create: 1, update: 2, publish: 1 });
  const repeated = await workflow.step(runId);
  assert.equal(repeated.publicUrl, "https://studio.replit.app/");
  assert.equal(calls.publish, 1);
});

test("one active run per business; same id is idempotent and different approval conflicts", async t => {
  const { workflow } = await fixture(t);
  const id = randomUUID();
  const first = await workflow.enqueue(id, approval);
  assert.deepEqual(await workflow.enqueue(id, approval), first);
  await assert.rejects(workflow.enqueue(randomUUID(), approval), /BUSINESS_BUILD_ACTIVE/);
  await assert.rejects(workflow.enqueue(id, { ...approval, approvalId: "different" }), /IDEMPOTENCY_CONFLICT/);
});

test("unknown create outcome blocks mutation replay and redacts provider error", async t => {
  const { workflow, port, calls, store } = await fixture(t);
  port.createApp = async () => { calls.create++; throw new Error("secret=NEVER_PERSIST_THIS"); };
  const id = randomUUID();
  await workflow.enqueue(id, approval);
  assert.equal((await workflow.step(id)).errorCode, "REMOTE_OUTCOME_UNKNOWN");
  await workflow.step(id);
  assert.equal(calls.create, 1);
  assert.equal(JSON.stringify(await store.load(id)).includes("NEVER_PERSIST_THIS"), false);
  await assert.rejects(workflow.resumeSourceObservation(id, approval), /SOURCE_OBSERVATION_NOT_RETRYABLE/);
});

test("source observation recovery preserves existing app and rechecks gates without replaying mutations", async t => {
  const { workflow, store, calls, port } = await fixture(t);
  const id = randomUUID();
  await workflow.enqueue(id, approval);
  const created = await workflow.step(id);
  const originalObserve = port.observeTask;
  port.observeTask = async () => ({ state: "blocked", code: "SOURCE_PREFLIGHT_UNVERIFIED" });
  assert.equal((await workflow.step(id)).phase, "blocked");
  await assert.rejects(workflow.resumeSourceObservation(id, { ...approval, ownerUserId: "other-owner" }), /RUN_OWNERSHIP_MISMATCH/);
  const resumed = await workflow.resumeSourceObservation(id, approval);
  assert.equal(resumed.replId, created.replId);
  assert.equal(resumed.currentTaskId, "design");
  assert.equal(resumed.evidence.length, 0);
  assert.deepEqual(calls, { create: 1, update: 0, publish: 0 });
  port.observeTask = originalObserve;
  await workflow.step(id);
  assert.equal((await store.load(id))?.currentTaskId, "frontend");
  assert.deepEqual(calls, { create: 1, update: 1, publish: 0 });
});

test("publish response recovery only re-reads status and never republishes the existing app", async t => {
  const { workflow, store, port, calls } = await fixture(t);
  const id = randomUUID(); await workflow.enqueue(id, approval);
  for (let i = 0; i < 5; i++) await workflow.step(id);
  port.observePublish = async () => ({ state: "blocked", code: "PUBLISH_SCHEMA_UNVERIFIED" });
  assert.equal((await workflow.step(id)).phase, "blocked");
  await assert.rejects(workflow.resumePublishObservation(id, { ...approval, ownerUserId: "someone-else" }), /RUN_OWNERSHIP_MISMATCH/);
  const previous = await store.load(id);
  const resumed = await workflow.resumePublishObservation(id, approval);
  assert.equal(resumed.replId, previous?.replId);
  assert.deepEqual(resumed.evidence, previous?.evidence);
  assert.equal(resumed.waitingSince, previous?.waitingSince);
  port.observePublish = async () => ({ state: "ready", publicUrl: "https://studio.replit.app/" });
  assert.equal((await workflow.step(id)).phase, "verifying");
  assert.deepEqual(calls, { create: 1, update: 2, publish: 1 });
});

test("persisted dispatch intent after crash never blindly creates another app", async t => {
  const { workflow, store, calls } = await fixture(t);
  const id = randomUUID();
  const run = await workflow.enqueue(id, approval);
  await store.save({ ...run, phase: "dispatching" });
  assert.equal((await workflow.step(id)).errorCode, "REMOTE_OUTCOME_UNKNOWN");
  assert.equal(calls.create, 0);
});

test("incomplete early evidence blocks next specialist dispatch", async t => {
  const { workflow, port, calls } = await fixture(t);
  const observe = port.observeTask;
  port.observeTask = async (run, task) => {
    const result = await observe(run, task);
    if (result.state === "passed") result.evidence.checks = ["approved-style"];
    return result;
  };
  const id = randomUUID();
  await workflow.enqueue(id, approval);
  await workflow.step(id);
  assert.equal((await workflow.step(id)).errorCode, "TASK_ACCEPTANCE_FAILED");
  assert.equal(calls.update, 0);
});

test("a boolean verification claim without checks and browser evidence cannot mark ready", async t => {
  const { workflow, verifier } = await fixture(t);
  verifier.verify = async () => ({ passed: true, checks: [], evidence: [] });
  const id = randomUUID();
  await workflow.enqueue(id, approval);
  for (let tick = 0; tick < 7; tick++) await workflow.step(id);
  const final = await workflow.step(id);
  assert.equal(final.phase, "failed");
  assert.equal(final.publicUrl, null);
});

test("approval revocation prevents remote writes and snapshot mismatch cannot enqueue", async t => {
  const { store, port, verifier, calls } = await fixture(t);
  let authorized = true;
  const workflow = new PublicationWorkflow(store, { async getApprovedBrief() {
    if (!authorized) throw new Error("revoked");
    return brief;
  } }, port, verifier, now);
  const id = randomUUID();
  await workflow.enqueue(id, approval);
  authorized = false;
  assert.equal((await workflow.step(id)).phase, "blocked");
  assert.equal(calls.create, 0);
  const mismatch = new PublicationWorkflow(store, { async getApprovedBrief() { return { ...brief, businessId: randomUUID() }; } }, port, verifier, now);
  await assert.rejects(mismatch.enqueue(randomUUID(), approval), /APPROVAL_BUSINESS_MISMATCH/);
});

test("remote task timeout retains business reservation until reconciliation", async t => {
  const { store, port, verifier } = await fixture(t);
  let clock = now();
  const workflow = new PublicationWorkflow(store, { async getApprovedBrief() { return brief; } }, port, verifier, () => clock, 1000);
  const id = randomUUID();
  await workflow.enqueue(id, approval);
  await workflow.step(id);
  clock = new Date(clock.getTime() + 1001);
  const timedOut = await workflow.step(id);
  assert.equal(timedOut.phase, "blocked");
  assert.equal(timedOut.errorCode, "TASK_TIMEOUT_RECONCILE");
  await assert.rejects(workflow.enqueue(randomUUID(), approval), /BUSINESS_BUILD_ACTIVE/);
});

test("catalog drift retries verification on same app without republishing", async t => {
  const { workflow, verifier, calls } = await fixture(t);
  const successful = verifier.verify;
  let first = true;
  verifier.verify = async (...args) => {
    if (first) { first = false; return { passed: false, checks: [], evidence: [], retryable: true }; }
    return successful(...args);
  };
  const id = randomUUID();
  await workflow.enqueue(id, approval);
  for (let tick = 0; tick < 6; tick++) await workflow.step(id);
  const retry = await workflow.step(id);
  assert.equal(retry.phase, "verifying");
  assert.equal(retry.verificationAttempts, 1);
  assert.equal((await workflow.step(id)).phase, "ready");
  assert.deepEqual(calls, { create: 1, update: 2, publish: 1 });
});

test("notification source requires actual persisted verification, verified owner and current observed revision", async t => {
  const { workflow, store } = await fixture(t);
  const id = randomUUID();
  const run = await workflow.enqueue(id, approval);
  const source = new WorkflowPublicationSource(store, { async getVerifiedOwnerEmail(owner, business) {
    assert.equal(owner, approval.ownerUserId);
    assert.equal(business, businessId);
    return "owner@example.com";
  } });
  assert.equal((await source.getPublication(id))?.phase, "queued");
  await store.save({ ...run, phase: "ready", publicUrl: "https://studio.replit.app/", candidateUrl: "https://studio.replit.app/" });
  assert.equal((await source.getPublication(id))?.phase, "unverified");
  await store.save(run);
  for (let tick = 0; tick < 8; tick++) await workflow.step(id);
  const ready = (await store.load(id))!;
  await store.save({ ...ready, verifiedCatalogRevision: 8 });
  const publication = await source.getPublication(id);
  assert.equal(publication?.catalogRevision, 8);
  assert.equal(publication?.verification?.httpStatus, 200);
  const wrongOwner = new WorkflowPublicationSource(store, { async getVerifiedOwnerEmail() { return null; } });
  assert.equal((await wrongOwner.getPublication(id))?.phase, "unverified");
});

test("owner status never exposes candidate URL, approval details or private snapshot", async t => {
  const { workflow } = await fixture(t);
  const run = await workflow.enqueue(randomUUID(), approval);
  const projected = toOwnerBuildStatus({ ...run, phase: "verifying", candidateUrl: "https://unverified.replit.app/" });
  assert.equal(projected.job.publicUrl, null);
  assert.equal(JSON.stringify(projected).includes("unverified.replit.app"), false);
  assert.equal(JSON.stringify(projected).includes(approval.approvalId), false);
  const blocked = toOwnerBuildStatus({ ...run, phase: "blocked", errorCode: "REMOTE_OUTCOME_UNKNOWN" });
  assert.equal(blocked.requiresReconciliation, true);
  assert.equal(blocked.job.phase, "failed");
});

test("notification worker sends only after ready and deduplicates repeated ready ticks", async t => {
  const { workflow, store } = await fixture(t);
  const id = randomUUID();
  await workflow.enqueue(id, approval);
  let sends = 0;
  const notifications = new PublicationNotificationWorker({
    publications: new WorkflowPublicationSource(store, { async getVerifiedOwnerEmail() { return "owner@example.com"; } }),
    outbox: createInMemoryNotificationOutbox(), sender: { from: "Shopcall <hello@example.com>" }, clock: now,
    resend: { async sendEmail() { sends++; return { kind: "accepted", id: "provider-message-1" }; }, async getEmailLastEvent() { return { kind: "event", lastEvent: "sent" }; } },
  });
  assert.equal((await notifications.step(id)).queued, false);
  for (let tick = 0; tick < 8; tick++) await workflow.step(id);
  assert.equal((await notifications.step(id)).queued, true);
  await notifications.step(id);
  assert.equal(sends, 1);
});
