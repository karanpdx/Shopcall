import test from "node:test";
import assert from "node:assert/strict";
import { readSourceInventory, inspectStaticArtifacts, ReplitArtifactTaskObserver } from "../../src/integrations/replit/artifact-observer";
import type { ReplitArtifactPort, ReplitMcpClient } from "../../src/integrations/replit/client";
import { createStorefrontPlan } from "../../src/integrations/orchestrator";
import type { BuildRun } from "../../src/integrations/publication/workflow";

const catalogUrl = "https://catalog.example.com/catalog";
const plan = createStorefrontPlan({ businessId: "f1fa84f0-c846-48ba-9cad-7bf073e906fb", businessName: "Studio", publicCatalogUrl: catalogUrl, catalogRevision: 1, approvedDesignBrief: "Green and cream ceramics." });
const replId = "ec75a51d-d0f4-4737-9d0d-2dbb1dd4182b";
const files = { "src/App.tsx": `<main data-shopcall-plan="${plan.id}"><a aria-label="Contact studio" href="mailto:hello@example.com">Contact</a><p data-shopcall-state="empty">No products</p><p data-shopcall-state="error">Unavailable</p></main>`, "src/index.css": "body { color: #203c33; background: #f6f4ec; margin: 0; }", "src/proxy.ts": `export async function GET() { const upstream = await fetch('${catalogUrl}', { cache: 'no-store' }); return upstream; } // /api/shopcall/catalog` };
function fixture() {
  const paths: string[] = [];
  const client: ReplitArtifactPort & Pick<ReplitMcpClient, "askBuildReadiness"> = {
    askBuildReadiness: async () => ({ content: [], structuredContent: { replId, phase: "paused", response: "Do not treat me as build proof." } }),
    listAppFiles: async (_id, path) => ({ content: [{ type: "text", text: path ? "App.tsx\nindex.css\nproxy.ts" : ".env.local\n.git/\nnode_modules/\nsrc/" }] }),
    readAppFile: async (_id, path) => { paths.push(path); return { content: [{ type: "text", text: files[path as keyof typeof files] }] }; },
  };
  return { client, paths };
}

test("source inventory traverses actual text listings while excluding private/dependency files", async () => {
  const { client, paths } = fixture();
  const inventory = await readSourceInventory(client, replId);
  assert.deepEqual(paths.sort(), Object.keys(files).sort());
  assert.equal(inventory.artifacts.length, 3);
  assert.match(inventory.digest, /^[a-f0-9]{64}$/);
  assert.ok(inspectStaticArtifacts(inventory, catalogUrl, plan.id).includes("canonical-endpoint-reference"));
  assert.equal(inspectStaticArtifacts(inventory, catalogUrl, "another-plan").includes("approved-style-reference"), false);
});

test("listing traversal escapes and oversized source fail closed", async () => {
  const { client } = fixture();
  client.listAppFiles = async () => ({ content: [{ type: "text", text: "../credentials.json" }] });
  await assert.rejects(readSourceInventory(client, replId), /ARTIFACT_PATH_UNVERIFIED/);
  const valid = fixture().client;
  await assert.rejects(readSourceInventory(valid, replId, { maxDirectories: 1, maxDepth: 4, maxFiles: 20, maxFileBytes: 1000, maxTotalBytes: 1000 }), /ARTIFACT_REVIEW_LIMIT/);
  await assert.rejects(readSourceInventory(valid, replId, { maxDirectories: 10, maxDepth: 4, maxFiles: 20, maxFileBytes: 1, maxTotalBytes: 1000 }), /ARTIFACT_REVIEW_LIMIT/);
});

test("source write handlers prevent read-only catalog preflight", async () => {
  const inventory = await readSourceInventory(fixture().client, replId);
  inventory.artifacts.push({ path: "src/mutation.ts", source: "router.post('/api/catalog', saveCatalog);" });
  assert.equal(inspectStaticArtifacts(inventory, catalogUrl, plan.id).includes("no-catalog-write-artifacts"), false);
});

test("busy provider blocks source evidence, paused permits static-only evidence, never QA", async () => {
  const f = fixture();
  const run = { replId, plan } as BuildRun;
  const observer = new ReplitArtifactTaskObserver(f.client, () => new Date("2026-11-20T23:00:00Z"));
  const design = plan.tasks.find(task => task.id === "design")!;
  const result = await observer.observe(run, design);
  assert.equal(result.state, "passed");
  if (result.state === "passed") {
    assert.equal(result.evidence.source, "artifact-review");
    assert.equal(result.evidence.checks.includes("responsive-design"), false);
    assert.equal(result.evidence.checks.includes("anonymous-public-url"), false);
  }
  f.client.askBuildReadiness = async () => ({ content: [], structuredContent: { replId, phase: "busy", response: "Agent is working" } });
  assert.equal((await observer.observe(run, design)).state, "pending");
  assert.equal((await observer.observe(run, plan.tasks.find(task => task.id === "qa")!)).state, "blocked");
});
