import test from "node:test";
import assert from "node:assert/strict";
import { ReplitPublicationAdapter } from "../../src/integrations/publication/replit-adapter";
import { createStorefrontPlan } from "../../src/integrations/orchestrator";
import type { BuildRun } from "../../src/integrations/publication/workflow";
import type { ReplitMcpPort } from "../../src/integrations/replit/client";

const plan = createStorefrontPlan({ businessId: "f1fa84f0-c846-48ba-9cad-7bf073e906fb", businessName: "Test studio", publicCatalogUrl: "https://catalog.example.com/api/public/test/catalog", catalogRevision: 1, approvedDesignBrief: "Simple and accessible" });
const url = "https://test-studio.replit.app/";
const profile = { verifiedAt: "2026-11-20T00:00:00Z", creationIdPath: ["replId"], publication: { presencePath: ["found"], statusPath: ["status"], readyValues: ["success"], failedValues: ["failed"], pendingValues: ["building"], urlPath: ["url"] } };
const run: BuildRun = { id: "d2c56f0d-724c-46e7-8fc7-910756f5a7f6", approval: { ownerUserId: "owner", businessId: plan.brief.businessId, approvalId: "approval" }, plan, phase: "verifying", replId: "actual-app", currentTaskId: "qa", candidateUrl: url, publicUrl: null, errorCode: null, createdAt: profile.verifiedAt, updatedAt: profile.verifiedAt, waitingSince: profile.verifiedAt, verificationChecks: [], verificationAttempts: 0, verifiedAt: null, verifiedCatalogRevision: null, verifiedHttpStatus: null, evidence: [{ planId: plan.id, taskId: "deploy", replId: "actual-app", source: "provider-publish-status", outcome: "passed", observedAt: profile.verifiedAt, artifactRef: url, checks: ["provider-published"] }] };
const unexpected = async (): Promise<never> => { throw new Error("No remote mutation expected."); };
const client: ReplitMcpPort = { discoverTools: async () => [], createApp: unexpected, updateApp: unexpected, askBuildReadiness: unexpected, publishApp: unexpected, getPublishStatus: unexpected, close: async () => {} };

test("fresh QA adapter restores only the persisted provider-confirmed origin before browser inspection", async () => {
  const origins = new Set<string>();
  let inspected = false;
  const adapter = new ReplitPublicationAdapter(client, profile, { async observe() { assert.ok(origins.has(url)); inspected = true; return { state: "pending" }; } }, candidate => origins.add(candidate));
  await adapter.observeTask(run, plan.tasks.find(task => task.id === "qa")!);
  assert.equal(inspected, true);
});

test("candidate URL without exact plan/app/publication provenance cannot register a browser origin", async () => {
  for (const altered of [{ ...run, evidence: [] }, { ...run, candidateUrl: "https://other.replit.app/" }, { ...run, replId: "another-app" }]) {
    let registered = false;
    const adapter = new ReplitPublicationAdapter(client, profile, { observe: unexpected }, () => { registered = true; });
    assert.deepEqual(await adapter.observeTask(altered, plan.tasks.find(task => task.id === "qa")!), { state: "blocked", code: "PUBLICATION_PROVENANCE_REQUIRED" });
    assert.equal(registered, false);
  }
});
