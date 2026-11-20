import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { SqliteRepository } from "../../src/server/repository";
import { SqliteBackendJobSource } from "../../src/integrations/backend/source";
import { BackendConfigurationError, BackendQueueRuntime } from "../../src/integrations/backend/queue";
import { runtimeReplitOwner, webReplitRedirectUri } from "../../src/integrations/backend/replit-web";
import { PublicationWorkflow, type ReplitBuildPort, type StorefrontVerifier } from "../../src/integrations/publication/workflow";
import { FileBuildRunStore } from "../../src/integrations/publication/store";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "shopcall-backend-runtime-"));
  const db = new Database(join(dir, "backend.sqlite")); db.pragma("foreign_keys=ON");
  for (const file of readdirSync("migrations").filter(name => name.endsWith(".sql")).sort()) db.exec(readFileSync(join("migrations", file), "utf8"));
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  process.env.PUBLIC_API_BASE = "https://api.backend.example.com";
  const repo = new SqliteRepository(db); const identity = repo.ensureOwnerBusiness("owner@example.com", "Studio Clay");
  const job = await repo.createBuildJob(identity.business.id, identity.owner.id, { designBrief: "Cream and green ceramics." });
  const source = new SqliteBackendJobSource(db, repo, "owner@example.com"); const runs = new FileBuildRunStore(join(dir, "runs"));
  const calls = { create: 0, update: 0, publish: 0, close: 0, email: 0 };
  const now = () => new Date("2026-11-20T23:00:00.000Z");
  const provider: ReplitBuildPort = {
    async createApp() { calls.create++; return { replId: "actual-app" }; }, async updateApp() { calls.update++; }, async publishApp() { calls.publish++; },
    async observeTask(run, task) { return { state: "passed", evidence: { planId: run.plan.id, taskId: task.id, replId: run.replId!, source: "independent-review", observedAt: now().toISOString(), outcome: "passed", artifactRef: "https://studio.replit.app/", checks: task.acceptanceCriteria } }; },
    async observePublish() { return { state: "ready", publicUrl: "https://studio.replit.app/" }; },
  };
  const verifier: StorefrontVerifier = { async verify(url, plan, replId) { return { passed: true, catalogRevision: plan.brief.catalogRevision, httpStatus: 200, checks: ["anonymous-public-url", "correct-live-business-catalog", "current-product-prices-stock", "usable-original-images", "same-origin-live-catalog-proxy"], evidence: [{ planId: plan.id, taskId: "deploy", replId, source: "browser-check", observedAt: now().toISOString(), outcome: "passed", artifactRef: url, checks: ["anonymous-public-url", "correct-live-business-catalog"] }] }; } };
  const workflow = new PublicationWorkflow(runs, source, provider, verifier, now);
  const runtime = new BackendQueueRuntime(source, runs, async ownerId => {
    assert.equal(ownerId, identity.owner.id);
    return { workflow, notifications: { async step(id) { assert.equal(id, job.id); calls.email++; return { queued: false, code: "NOT_CONFIGURED" as const }; } }, async close() { calls.close++; } };
  });
  return { db, repo, job, source, runs, runtime, calls, workflow, provider, identity };
}

test("actual B queue maps ordered C phases; URL remains null until verified and run UUID equals approved job", async t => {
  const f = await fixture(t);
  const phases: string[] = [];
  for (let i = 0; i < 7; i++) {
    const result = await f.runtime.tick(); phases.push(result.phase);
    const job = await f.source.getJob(f.job.id);
    if (i < 6) { assert.equal(job!.publicationStatus, "pending"); assert.equal(job!.publicUrl, null); assert.equal(f.calls.email, 0); }
  }
  assert.deepEqual(phases, ["awaiting_task", "awaiting_task", "awaiting_task", "ready_to_publish", "publishing", "verifying", "ready"]);
  assert.equal((await f.runs.load(f.job.id))!.id, f.job.id);
  assert.equal((await f.source.getJob(f.job.id))!.publicUrl, "https://studio.replit.app/");
  assert.equal(f.calls.create, 1); assert.equal(f.calls.email, 1);
  assert.equal((await f.runtime.tick()).phase, "idle");
  assert.equal((await f.runtime.tick({ runId: f.job.id })).phase, "ready");
  assert.equal(f.calls.create, 1); assert.equal(f.calls.publish, 1);
});

test("restarts between B claim and C run persistence recover same job without losing approval", async t => {
  const f = await fixture(t); await f.repo.claimNextBuildJob();
  assert.equal(await f.runs.load(f.job.id), null);
  assert.equal((await f.runtime.tick()).jobId, f.job.id);
  assert.equal(f.calls.create, 1);
  assert.equal((await f.runs.load(f.job.id))!.approval.approvalId, f.job.id);
});

test("unknown remote create outcome keeps B active and cannot trigger duplicate app", async t => {
  const f = await fixture(t);
  f.provider.createApp = async () => { f.calls.create++; throw new Error("secret-provider-payload"); };
  const first = await f.runtime.tick(); assert.equal(first.errorCode, "REMOTE_OUTCOME_UNKNOWN");
  assert.equal((await f.runtime.tick()).phase, "blocked"); assert.equal(f.calls.create, 1);
  const job = (await f.source.getJob(f.job.id))!;
  assert.equal(job.buildStatus, "running"); assert.equal(job.publicationStatus, "pending"); assert.equal(job.publicUrl, null);
  assert.ok(!JSON.stringify(job).includes("secret-provider-payload"));
  await assert.rejects(f.repo.createBuildJob(f.identity.business.id, f.identity.owner.id, {}), { code: "CONFLICT" });
});

test("persisted dispatch intent blocks replay; missing config leaves queue recoverable", async t => {
  const f = await fixture(t);
  const bad = new BackendQueueRuntime(f.source, f.runs, async () => { throw new BackendConfigurationError("REPLIT_RESPONSE_PROFILE_REQUIRED"); });
  assert.equal((await bad.tick()).errorCode, "REPLIT_RESPONSE_PROFILE_REQUIRED");
  assert.equal(f.calls.create, 0);
  const run = await f.workflow.enqueue(f.job.id, { ownerUserId: f.identity.owner.id, businessId: f.identity.business.id, approvalId: f.job.id });
  await f.runs.save({ ...run, phase: "dispatching" });
  assert.equal((await f.runtime.tick()).errorCode, "REMOTE_OUTCOME_UNKNOWN"); assert.equal(f.calls.create, 0);
});

test("forged approval ownership and unknown owner email cannot reach provider", async t => {
  const f = await fixture(t);
  await assert.rejects(f.source.assertOwnerJob(randomUUID(), f.identity.business.id, f.job.id), { code: "NOT_FOUND" });
  assert.equal(await f.source.getVerifiedOwnerEmail(randomUUID(), f.identity.business.id), null);
  assert.equal(await f.source.getVerifiedOwnerEmail(f.identity.owner.id, f.identity.business.id), "owner@example.com");
  const spec = (await f.source.getSpec(f.job.id))!;
  f.db.prepare("UPDATE build_jobs SET spec=? WHERE id=?").run(JSON.stringify({ ...spec, approvedByOwnerId: randomUUID() }), f.job.id);
  assert.equal((await f.runtime.tick()).errorCode, "APPROVED_BUILD_SNAPSHOT_REQUIRED"); assert.equal(f.calls.create, 0);
});

test("web callback uses app origin, CLI callback is ignored, and alias never silently crosses production owner", () => {
  assert.equal(webReplitRedirectUri({ APP_BASE_URL: "http://localhost:3000", REPLIT_REDIRECT_URI: "http://127.0.0.1:8788/api/replit/callback" }), "http://localhost:3000/api/replit/callback");
  assert.throws(() => webReplitRedirectUri({ APP_BASE_URL: "https://app.example.com", REPLIT_WEB_REDIRECT_URI: "https://evil.example/api/replit/callback" }), /REPLIT_WEB_CALLBACK_MISMATCH/);
  assert.throws(() => webReplitRedirectUri({ APP_BASE_URL: "https://app.example.com", NODE_ENV: "production" }), /MANAGED_REPLIT_CREDENTIAL_KEY_REQUIRED/);
  assert.equal(runtimeReplitOwner("actual-owner", true, {}), "actual-owner");
  assert.equal(runtimeReplitOwner("actual-owner", true, { REPLIT_CONNECTION_OWNER_ID: "shopcall-local-demo-owner" }), "shopcall-local-demo-owner");
  assert.throws(() => runtimeReplitOwner("actual-owner", true, { NODE_ENV: "production", REPLIT_CONNECTION_OWNER_ID: "shopcall-local-demo-owner" }), /REPLIT_CONNECTION_OWNER_MISMATCH/);
  assert.throws(() => runtimeReplitOwner("other-owner", false, { REPLIT_CONNECTION_OWNER_ID: "shopcall-local-demo-owner" }), /REPLIT_CONNECTION_OWNER_MISMATCH/);
});

test("a forged ready flag without actual workflow proof never mirrors URL or emails", async t => {
  const f = await fixture(t);
  await f.repo.claimNextBuildJob();
  const run = await f.workflow.enqueue(f.job.id, { ownerUserId: f.identity.owner.id, businessId: f.identity.business.id, approvalId: f.job.id });
  await f.runs.save({ ...run, phase: "ready", publicUrl: "https://unverified.replit.app/", candidateUrl: "https://unverified.replit.app/" });
  const result = await f.runtime.tick({ runId: f.job.id });
  assert.equal(result.phase, "blocked");
  assert.equal((await f.source.getJob(f.job.id))!.publicUrl, null);
  assert.equal((await f.source.getJob(f.job.id))!.publicationStatus, "pending");
  assert.equal(f.calls.email, 0);
});
