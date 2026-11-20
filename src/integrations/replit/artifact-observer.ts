import { createHash } from "node:crypto";
import { z } from "zod";
import type { BuildRun, TaskObservation } from "../publication/workflow";
import type { StorefrontTask, TaskEvidence } from "../orchestrator";
import { assertPlanIntegrity } from "../orchestrator";
import type { ReplitArtifactPort, ReplitMcpClient, ReplitToolResult } from "./client";

type SourceArtifact = { path: string; source: string };
export type SourceInventory = { artifacts: SourceArtifact[]; digest: string };
export type ArtifactReviewLimits = { maxDirectories: number; maxFiles: number; maxFileBytes: number; maxTotalBytes: number; maxDepth: number };
const defaults: ArtifactReviewLimits = { maxDirectories: 80, maxFiles: 180, maxFileBytes: 200_000, maxTotalBytes: 3_000_000, maxDepth: 8 };
const ignoredDirectory = /^(?:node_modules|dist|build|coverage|vendor|mockup-sandbox)$/i;
const sourceExtension = /\.(?:[cm]?[jt]sx?|css|html|json)$/i;
const privateName = /(?:^|\.)(?:env|pem|key|p12|pfx|sqlite|db)(?:\.|$)|^(?:credentials|secrets|tokens?)(?:\.|$)/i;

function textContent(result: ReplitToolResult) {
  if (result.isError || !result.content.length || result.content.some(item => item.type !== "text" || typeof item.text !== "string")) throw new Error("ARTIFACT_RESPONSE_UNVERIFIED");
  return result.content.map(item => item.text!).join("\n");
}

/** Actual provider listing/read responses are text content blocks, not a fabricated JSON schema. */
export async function readSourceInventory(client: ReplitArtifactPort, replId: string, limits: ArtifactReviewLimits = defaults): Promise<SourceInventory> {
  const directories: Array<{ path?: string; depth: number }> = [{ depth: 0 }];
  const files: string[] = [];
  let listed = 0;
  while (directories.length) {
    const directory = directories.shift()!;
    if (++listed > limits.maxDirectories || directory.depth > limits.maxDepth) throw new Error("ARTIFACT_REVIEW_LIMIT");
    const response = textContent(await client.listAppFiles(replId, directory.path));
    if (Buffer.byteLength(response) > 100_000) throw new Error("ARTIFACT_LIST_LIMIT");
    for (const raw of response.split(/\r?\n/).filter(Boolean)) {
      const isDirectory = raw.endsWith("/");
      const name = isDirectory ? raw.slice(0, -1) : raw;
      if (!name || name === "." || name === ".." || /[\\/\u0000-\u001f]/.test(name)) throw new Error("ARTIFACT_PATH_UNVERIFIED");
      if (name.startsWith(".") || privateName.test(name)) continue;
      const path = directory.path ? `${directory.path}/${name}` : name;
      if (isDirectory) {
        if (!ignoredDirectory.test(name)) directories.push({ path, depth: directory.depth + 1 });
      } else if (sourceExtension.test(name)) {
        files.push(path);
        if (files.length > limits.maxFiles) throw new Error("ARTIFACT_REVIEW_LIMIT");
      }
    }
  }
  const artifacts: SourceArtifact[] = [];
  let bytes = 0;
  // The provider's live filesystem tools have returned intermittent errors under concurrent
  // reads. Serialize requests; safe read retries remain bounded in the MCP client.
  for (const path of files) {
    const artifact = { path, source: textContent(await client.readAppFile(replId, path)) };
    const size = Buffer.byteLength(artifact.source);
    bytes += size;
    if (size > limits.maxFileBytes || bytes > limits.maxTotalBytes) throw new Error("ARTIFACT_REVIEW_LIMIT");
    artifacts.push(artifact);
  }
  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  const digest = createHash("sha256").update(JSON.stringify(artifacts)).digest("hex");
  return { artifacts, digest };
}

/** Checks are static references in reviewed source, not proof of rendered behavior or build success. */
export function inspectStaticArtifacts(inventory: SourceInventory, publicCatalogUrl: string, planId: string): string[] {
  const sources = inventory.artifacts.filter(file => /\.(?:[cm]?[jt]sx?|css|html)$/i.test(file.path));
  const text = sources.map(file => file.source).join("\n");
  const frontend = sources.filter(file => /\.(?:tsx|jsx|html)$/i.test(file.path));
  const checks: string[] = [];
  if (text.includes("data-shopcall-plan") && text.includes(planId)) checks.push("approved-style-reference");
  if (inventory.artifacts.some(file => /\.css$/i.test(file.path) && file.source.trim().length > 30) || frontend.some(file => /className\s*=|style\s*=/.test(file.source))) checks.push("design-artifacts");
  if (/mailto:|contactEmail/.test(text)) checks.push("contact-integration-artifacts");
  if (frontend.some(file => /(?:<\w|createElement|createRoot)/.test(file.source))) checks.push("frontend-artifacts");
  if (/aria-label|aria-labelledby|<label\b/.test(text)) checks.push("accessible-control-artifacts");
  if (/data-shopcall-state/.test(text) && /(?:upstream-error|error|failed)/i.test(text) && /(?:empty|no products|nothing)/i.test(text)) checks.push("failure-state-artifacts");
  if (/(?:\bfetch\s*\(|\baxios\.get\s*\()/.test(text)) checks.push("catalog-fetch-artifacts");
  if (text.includes(publicCatalogUrl)) checks.push("canonical-endpoint-reference");
  if (/\/api\/shopcall\/catalog/.test(text) && /(?:\bGET\b|\.get\s*\()/.test(text)) checks.push("catalog-proxy-artifacts");
  const writeArtifact = /\b(?:router|app)\.(?:post|put|patch|delete)\s*\(|export\s+(?:async\s+)?function\s+(?:POST|PUT|PATCH|DELETE)\b|method\s*:\s*["'`](?:POST|PUT|PATCH|DELETE)["'`]|\bdb\.(?:insert|update|delete)\s*\(|\b(?:INSERT\s+INTO|DELETE\s+FROM)\b/i;
  if (sources.length > 0 && !sources.some(file => writeArtifact.test(file.source))) checks.push("no-catalog-write-artifacts");
  return checks;
}

/** Provider-idle plus independently retrieved source preflight, limited to pre-publication tasks. */
export class ReplitArtifactTaskObserver {
  constructor(private readonly client: ReplitArtifactPort & Pick<ReplitMcpClient, "askBuildReadiness">, private readonly now = () => new Date(), private readonly limits = defaults) {}
  async observe(run: BuildRun, task: StorefrontTask): Promise<TaskObservation> {
    assertPlanIntegrity(run.plan);
    const expected = run.plan.tasks.find(item => item.id === task.id);
    if (!run.replId || !["design", "frontend", "catalogIntegration"].includes(task.id) || JSON.stringify(expected) !== JSON.stringify(task)) return { state: "blocked", code: "ARTIFACT_OBSERVER_SCOPE_INVALID" };
    const status = await this.client.askBuildReadiness(run.replId);
    const idle = z.object({ replId: z.string(), phase: z.enum(["paused", "busy"]), response: z.string() }).strict().safeParse(status.structuredContent);
    if (!idle.success || idle.data.replId !== run.replId) return { state: "blocked", code: "PROVIDER_IDLE_RESPONSE_UNVERIFIED" };
    if (idle.data.phase === "busy") return { state: "pending" };
    try {
      const inventory = await readSourceInventory(this.client, run.replId, this.limits);
      const checks = inspectStaticArtifacts(inventory, run.plan.brief.publicCatalogUrl, run.plan.id);
      if (!task.acceptanceCriteria.every(check => checks.includes(check))) return { state: "blocked", code: "SOURCE_PREFLIGHT_INCOMPLETE" };
      const evidence: TaskEvidence = { planId: run.plan.id, taskId: task.id, replId: run.replId, source: "artifact-review", observedAt: this.now().toISOString(), outcome: "passed", artifactRef: `replit-app:${run.replId}/source-sha256/${inventory.digest}`, checks: task.acceptanceCriteria };
      return { state: "passed", evidence };
    } catch { return { state: "blocked", code: "SOURCE_PREFLIGHT_UNVERIFIED" }; }
  }
}
