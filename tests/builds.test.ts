import test from "node:test";
import assert from "node:assert/strict";
import { body, call, params, signIn } from "./helpers/backend";
import * as builds from "../src/app/api/builds/route";
import * as buildById from "../src/app/api/builds/[id]/route";
import * as business from "../src/app/api/business/route";
import { publicationRepository, repository } from "../src/server/repository";

const getJob = async (cookie: string | undefined, id: string) => buildById.GET(call("GET", `/api/builds/${id}`, { cookie }), params({ id }));

test("build request persists as queued with a frozen spec; one active build per store", async () => {
  const { cookie, session } = await signIn("builds@shop.example", "Build Shop");
  const res = await builds.POST(call("POST", "/api/builds", { cookie, body: { designBrief: "Cream and dark green, minimal" } }));
  assert.equal(res.status, 202);
  const job = (await body(res)).data;
  assert.equal(job.buildStatus, "queued");
  assert.equal(job.publicationStatus, "pending");
  assert.equal(job.publicUrl, null);
  assert.equal((await body(await getJob(cookie, job.id))).data.id, job.id);

  const spec = await repository().getBuildSpec(job.id);
  assert.equal(spec!.publicCatalogUrl, "https://api.shopcall.test/api/public/build-shop/catalog");
  assert.equal(spec!.approvedByOwnerId, session.owner.id);
  assert.equal(spec!.designBrief, "Cream and dark green, minimal");

  assert.equal((await builds.POST(call("POST", "/api/builds", { cookie }))).status, 409);
  assert.equal((await builds.POST(call("POST", "/api/builds", { cookie, body: { replitToken: "x" } }))).status, 400);

  // Worker path: claim → running; nothing else queued.
  const claimed = await repository().claimNextBuildJob();
  assert.equal(claimed!.job.id, job.id);
  assert.equal(claimed!.job.buildStatus, "running");
  assert.equal(await repository().claimNextBuildJob(), null);
});

test("build and publication states are independent; URL only after verified publication", async () => {
  const { cookie } = await signIn("states@shop.example", "States Shop");
  const job = (await body(await builds.POST(call("POST", "/api/builds", { cookie })))).data;
  const r = repository();

  await assert.rejects(r.updateBuildJob(job.id, { publicationStatus: "completed", publicUrl: "https://x.replit.app" }), /only after the build completed/);
  await assert.rejects(r.updateBuildJob(job.id, { publicUrl: "https://x.replit.app" }), /publicUrl requires/);

  await r.updateBuildJob(job.id, { buildStatus: "running", providerJobId: "repl-123" });
  const built = await r.updateBuildJob(job.id, { buildStatus: "completed" });
  assert.equal(built.publicationStatus, "pending");
  assert.equal(built.publicUrl, null);
  assert.equal((await body(await business.GET(call("GET", "/api/business", { cookie })))).data.publishedUrl, null);

  await assert.rejects(r.updateBuildJob(job.id, { publicationStatus: "completed" }), /requires the verified publicUrl/);
  await assert.rejects(r.updateBuildJob(job.id, { buildStatus: "running" }), /Illegal build transition/);

  const done = await r.updateBuildJob(job.id, { publicationStatus: "completed", publicUrl: "https://clay.replit.app" });
  assert.equal(done.publicUrl, "https://clay.replit.app");
  assert.equal(done.providerJobId, "repl-123");
  assert.equal((await body(await business.GET(call("GET", "/api/business", { cookie })))).data.publishedUrl, "https://clay.replit.app");
  await assert.rejects(r.updateBuildJob(job.id, { publicationStatus: "failed" }), /already completed/);

  // A new build is allowed once the previous one finished.
  assert.equal((await builds.POST(call("POST", "/api/builds", { cookie }))).status, 202);
});

test("failed provider calls record honest failure without a URL", async () => {
  const { cookie } = await signIn("fail@shop.example", "Fail Shop");
  const a = (await body(await builds.POST(call("POST", "/api/builds", { cookie })))).data;
  const failed = await repository().updateBuildJob(a.id, { buildStatus: "failed", errorMessage: "Replit create timed out" });
  assert.equal(failed.buildStatus, "failed");
  assert.equal(failed.publicationStatus, "pending");
  assert.equal(failed.publicUrl, null);
  await assert.rejects(repository().updateBuildJob(a.id, { buildStatus: "completed" }), /Illegal/);

  // Publication failure via the v0 PublicationRepository adapter.
  const b = (await body(await builds.POST(call("POST", "/api/builds", { cookie })))).data;
  await publicationRepository.updateJob(b.id, { phase: "building", replId: "repl-9" });
  await publicationRepository.updateJob(b.id, { phase: "publishing" });
  await publicationRepository.updateJob(b.id, { phase: "failed", error: "publish_app returned 500" });
  const after = (await body(await getJob(cookie, b.id))).data;
  assert.deepEqual([after.buildStatus, after.publicationStatus, after.publicUrl, after.errorMessage], ["completed", "failed", null, "publish_app returned 500"]);
  const snap = await publicationRepository.getApprovedSnapshot(after.businessId, b.id);
  assert.equal(snap.publicCatalogUrl, "https://api.shopcall.test/api/public/fail-shop/catalog");
});

test("build jobs: unauthenticated 401, other business 404", async () => {
  const { cookie } = await signIn("owner-a@shop.example", "Owner A");
  const job = (await body(await builds.POST(call("POST", "/api/builds", { cookie })))).data;
  assert.equal((await getJob(undefined, job.id)).status, 401);
  const { cookie: other } = await signIn("owner-b@shop.example", "Owner B");
  assert.equal((await getJob(other, job.id)).status, 404);
  assert.equal((await builds.POST(call("POST", "/api/builds"))).status, 401);
});

test("build request fails clearly when PUBLIC_API_BASE is missing", async () => {
  const { cookie } = await signIn("nobase@shop.example", "No Base");
  const saved = process.env.PUBLIC_API_BASE;
  delete process.env.PUBLIC_API_BASE;
  try {
    const res = await builds.POST(call("POST", "/api/builds", { cookie }));
    assert.equal(res.status, 503);
    assert.equal((await body(res)).error!.code, "CONFIGURATION_ERROR");
  } finally {
    process.env.PUBLIC_API_BASE = saved;
  }
});
