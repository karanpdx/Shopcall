import { createHash } from "node:crypto";
import { z } from "zod";
import type { BuildRun, TaskObservation } from "../publication/workflow";
import type { StorefrontTask, TaskEvidence } from "../orchestrator";
import { assertPlanIntegrity } from "../orchestrator";
import type { ReplitArtifactPort, ReplitMcpClient, ReplitToolResult } from "./client";

type SourceArtifact = { path: string; source: string };
export type SourceInventory = { artifacts: SourceArtifact[]; digest: string; complete?: boolean; omittedPaths?: string[] };
type SourceSelection = {
  enter(path: string): boolean;
  read(path: string): boolean;
  tolerateReadErrors?: boolean;
  enough?(inventory: SourceInventory): boolean;
};
export type ArtifactReviewLimits = { maxDirectories: number; maxFiles: number; maxFileBytes: number; maxTotalBytes: number; maxDepth: number; maxElapsedMs?: number };
const defaults: ArtifactReviewLimits = { maxDirectories: 80, maxFiles: 180, maxFileBytes: 200_000, maxTotalBytes: 3_000_000, maxDepth: 8, maxElapsedMs: 90_000 };
const ignoredDirectory = /^(?:node_modules|dist|build|coverage|vendor|mockup-sandbox|tests|__tests__|__mocks__)$/i;
const sourceExtension = /\.(?:[cm]?[jt]sx?|css|html|json)$/i;
const privateName = /(?:^|\.)(?:env|pem|key|p12|pfx|sqlite|db)(?:\.|$)|^(?:credentials|secrets|tokens?)(?:\.|$)/i;
// Queue ticks construct fresh provider runtimes, so this bound must outlive an observer
// instance. Process restarts still retain the workflow's original durable wait deadline.
const transientReadFailures = new Map<string, number>();
function recordReadFailure(key: string) {
  if (!transientReadFailures.has(key) && transientReadFailures.size >= 512) {
    const oldest = transientReadFailures.keys().next().value;
    if (oldest !== undefined) transientReadFailures.delete(oldest);
  }
  const failures = (transientReadFailures.get(key) ?? 0) + 1;
  transientReadFailures.set(key, failures);
  return failures;
}

function textContent(result: ReplitToolResult) {
  if (result.isError || !result.content.length || result.content.some(item => item.type !== "text" || typeof item.text !== "string")) throw new Error("ARTIFACT_RESPONSE_UNVERIFIED");
  return result.content.map(item => item.text!).join("\n");
}

/** Actual provider listing/read responses are text content blocks, not a fabricated JSON schema. */
export async function readSourceInventory(client: ReplitArtifactPort, replId: string, limits: ArtifactReviewLimits = defaults, selection?: SourceSelection): Promise<SourceInventory> {
  const deadline = Date.now() + (limits.maxElapsedMs ?? 90_000);
  let timeLimitReached = false;
  async function bounded<T>(read: () => Promise<T>): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { timeLimitReached = true; throw new Error("ARTIFACT_TIME_LIMIT"); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([read(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { timeLimitReached = true; reject(new Error("ARTIFACT_TIME_LIMIT")); }, remaining);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  const directories: Array<{ path?: string; depth: number }> = [{ depth: 0 }];
  const files: string[] = [];
  const omittedPaths: string[] = [];
  let listed = 0;
  while (directories.length) {
    const directory = directories.shift()!;
    if (++listed > limits.maxDirectories || directory.depth > limits.maxDepth) throw new Error("ARTIFACT_REVIEW_LIMIT");
    let response: string;
    try { response = textContent(await bounded(() => client.listAppFiles(replId, directory.path))); }
    catch (error) {
      if (!selection?.tolerateReadErrors) throw error;
      omittedPaths.push(`directory:${directory.path ?? "root"}`);
      if (timeLimitReached) { omittedPaths.push("time-budget:directory-inventory"); break; }
      continue;
    }
    if (Buffer.byteLength(response) > 100_000) throw new Error("ARTIFACT_LIST_LIMIT");
    for (const raw of response.split(/\r?\n/).filter(Boolean)) {
      const isDirectory = raw.endsWith("/");
      const name = isDirectory ? raw.slice(0, -1) : raw;
      if (!name || name === "." || name === ".." || /[\\/\u0000-\u001f]/.test(name)) throw new Error("ARTIFACT_PATH_UNVERIFIED");
      if (name.startsWith(".") || privateName.test(name)) continue;
      const path = directory.path ? `${directory.path}/${name}` : name;
      if (isDirectory) {
        if (!ignoredDirectory.test(name) && (!selection || selection.enter(path))) directories.push({ path, depth: directory.depth + 1 });
      } else if (sourceExtension.test(name) && (!selection || selection.read(path))) {
        files.push(path);
        if (files.length > limits.maxFiles) throw new Error("ARTIFACT_REVIEW_LIMIT");
      }
    }
  }
  const artifacts: SourceArtifact[] = [];
  let bytes = 0;
  // The provider's live filesystem tools have returned intermittent errors under concurrent
  // reads. Serialize requests; safe read retries remain bounded in the MCP client.
  let attempted = 0;
  for (const path of files) {
    if (timeLimitReached) { omittedPaths.push("time-budget:remaining-runtime-source"); break; }
    attempted++;
    let artifact: SourceArtifact;
    try { artifact = { path, source: textContent(await bounded(() => client.readAppFile(replId, path))) }; }
    catch (error) {
      if (!selection?.tolerateReadErrors) throw error;
      omittedPaths.push(path);
      if (timeLimitReached) { omittedPaths.push("time-budget:remaining-runtime-source"); break; }
      continue;
    }
    const size = Buffer.byteLength(artifact.source);
    bytes += size;
    if (size > limits.maxFileBytes || bytes > limits.maxTotalBytes) throw new Error("ARTIFACT_REVIEW_LIMIT");
    artifacts.push(artifact);
    if (selection?.enough?.({ artifacts, digest: "", complete: false, omittedPaths })) break;
  }
  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  const digest = createHash("sha256").update(JSON.stringify(artifacts)).digest("hex");
  return { artifacts, digest, complete: omittedPaths.length === 0 && attempted === files.length, omittedPaths };
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
  if (sources.length > 0 && inventory.complete !== false && !inventory.omittedPaths?.length && !sources.some(file => writeArtifact.test(file.source))) checks.push("no-catalog-write-artifacts");
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
      const catalog = task.id === "catalogIntegration";
      const key = `${run.id}/${task.id}`;
      const selection: SourceSelection = {
        enter: path => !/(?:^|\/)components\/ui(?:\/|$)/i.test(path) && (catalog || !/(?:^|\/)(?:api|api-server|server|lib|hooks)(?:\/|$)/i.test(path)),
        read: path => !/\.(?:test|spec|stories)\.[cm]?[jt]sx?$/i.test(path) && !/\.d\.[cm]?ts$/i.test(path) && (catalog ? /\.[cm]?[jt]sx?$/i.test(path) : /\.(?:tsx|jsx|css|html)$/i.test(path)),
        tolerateReadErrors: true,
        // Positive design/frontend artifact references can be established without reading unrelated
        // boilerplate. Catalog absence claims require the complete selected runtime source inventory.
        enough: catalog ? undefined : inventory => task.acceptanceCriteria.every(check => inspectStaticArtifacts(inventory, run.plan.brief.publicCatalogUrl, run.plan.id).includes(check)),
      };
      const inventory = await readSourceInventory(this.client, run.replId, this.limits, selection);
      const checks = inspectStaticArtifacts(inventory, run.plan.brief.publicCatalogUrl, run.plan.id);
      if (!task.acceptanceCriteria.every(check => checks.includes(check))) {
        if (inventory.omittedPaths?.length) {
          const failures = recordReadFailure(key);
          return failures < 3 ? { state: "pending" } : { state: "blocked", code: "SOURCE_PREFLIGHT_UNVERIFIED" };
        }
        return { state: "blocked", code: "SOURCE_PREFLIGHT_INCOMPLETE" };
      }
      transientReadFailures.delete(key);
      const evidence: TaskEvidence = { planId: run.plan.id, taskId: task.id, replId: run.replId, source: "artifact-review", observedAt: this.now().toISOString(), outcome: "passed", artifactRef: `replit-app:${run.replId}/source-sha256/${inventory.digest}`, checks: task.acceptanceCriteria };
      return { state: "passed", evidence };
    } catch { return { state: "blocked", code: "SOURCE_PREFLIGHT_UNVERIFIED" }; }
  }
}
