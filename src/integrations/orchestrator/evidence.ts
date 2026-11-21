import { z } from "zod";
import { assertPlanIntegrity, TASK_IDS, type StorefrontPlan, type TaskId } from "./plan";

const evidenceSchema = z.object({
  planId: z.string().min(1).max(100),
  taskId: z.enum(TASK_IDS),
  replId: z.string().min(1).max(160),
  source: z.enum(["artifact-review", "browser-check", "network-check", "provider-build-status", "provider-publish-status", "independent-review"]),
  observedAt: z.iso.datetime({ offset: true }),
  outcome: z.enum(["passed", "failed"]),
  artifactRef: z.string().min(1).max(2000).refine(ref => !/[\r\n?#]/.test(ref), "Use redacted artifact reference without credentials/query parameters."),
  checks: z.array(z.string().min(1).max(160)).min(1).max(30),
}).strict();

export type TaskEvidence = z.infer<typeof evidenceSchema>;
export type DeploymentGate = { allowed: boolean; blockers: { taskId: TaskId; reason: string }[] };

const allowedSources: Record<TaskId, TaskEvidence["source"][]> = {
  design: ["artifact-review", "independent-review"],
  frontend: ["artifact-review", "independent-review"],
  catalogIntegration: ["artifact-review", "independent-review"],
  qa: ["browser-check", "independent-review"],
  deploy: ["provider-publish-status", "browser-check"],
};

/** Reject model prose masquerading as structured evidence; caller's verifier must actually observe artifacts. */
export function validateTaskEvidence(input: unknown): TaskEvidence {
  return evidenceSchema.parse(input);
}

function currentEvidence(plan: StorefrontPlan, entries: TaskEvidence[], replId: string, taskId: TaskId, now: Date): TaskEvidence[] {
  return entries.map(validateTaskEvidence).filter(entry => {
    const age = now.getTime() - Date.parse(entry.observedAt);
    return entry.planId === plan.id && entry.replId === replId && entry.taskId === taskId &&
      allowedSources[taskId].includes(entry.source) && age >= 0 && age <= 60 * 60 * 1000;
  }).reverse().sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
}

/**
 * Pre-publication gate. Evidence originates in a trusted backend EvidenceVerifier port,
 * never merchant inputs or a generated app's uninspected completion claim.
 * Prepublication source-artifact checks are static preflight, not browser acceptance.
 */
export function evaluateDeploymentGate(plan: StorefrontPlan, entries: TaskEvidence[], replId: string, now = new Date()): DeploymentGate {
  assertPlanIntegrity(plan);
  const blockers: DeploymentGate["blockers"] = [];
  const observed = new Map<TaskId, TaskEvidence>();
  for (const task of plan.tasks.slice(0, plan.tasks.findIndex(task => task.id === "deploy"))) {
    const latest = currentEvidence(plan, entries, replId, task.id, now)[0];
    if (!latest) {
      blockers.push({ taskId: task.id, reason: "No fresh source-artifact evidence for this exact plan and Replit app." });
      continue;
    }
    if (latest.outcome !== "passed") {
      blockers.push({ taskId: task.id, reason: "Latest observed task result failed." });
      continue;
    }
    const missing = task.acceptanceCriteria.filter(check => !latest.checks.includes(check));
    if (missing.length) {
      blockers.push({ taskId: task.id, reason: `Missing acceptance evidence: ${missing.join(", ")}.` });
      continue;
    }
    const invalidDependency = task.dependsOn.find(id => !observed.has(id) || Date.parse(observed.get(id)!.observedAt) > Date.parse(latest.observedAt));
    if (invalidDependency) {
      blockers.push({ taskId: task.id, reason: `Dependency ${invalidDependency} lacks earlier successful evidence.` });
      continue;
    }
    observed.set(task.id, latest);
  }
  return { allowed: blockers.length === 0, blockers };
}

/** Validate the completed prefix before dispatching the next specialist task. */
export function evaluateTaskGate(plan: StorefrontPlan, entries: TaskEvidence[], replId: string, taskId: Exclude<TaskId, "deploy">, now = new Date()): DeploymentGate {
  const index = plan.tasks.findIndex(task => task.id === taskId);
  if (index < 0) throw new Error("Unknown storefront task.");
  const prefixIds = new Set(plan.tasks.slice(0, index + 1).map(task => task.id));
  const blockers = evaluateDeploymentGate(plan, entries, replId, now).blockers.filter(blocker => prefixIds.has(blocker.taskId));
  if (taskId === "qa") {
    const task = plan.tasks[index];
    const publication = currentEvidence(plan, entries, replId, "deploy", now).find(entry => entry.source === "provider-publish-status");
    const qa = currentEvidence(plan, entries, replId, "qa", now)[0];
    const lastStatic = currentEvidence(plan, entries, replId, "catalogIntegration", now)[0];
    if (!publication || publication.outcome !== "passed" || !publication.checks.includes("provider-published")) {
      blockers.push({ taskId: "qa", reason: "Actual provider publication must precede rendered QA." });
    }
    if (!qa || qa.outcome !== "passed" || task.acceptanceCriteria.some(check => !qa.checks.includes(check))) {
      blockers.push({ taskId: "qa", reason: "Real postpublication browser QA lacks current complete acceptance evidence." });
    }
    if (publication && qa && Date.parse(qa.observedAt) < Date.parse(publication.observedAt)) {
      blockers.push({ taskId: "qa", reason: "QA evidence predates actual provider publication." });
    }
    if (publication && lastStatic && Date.parse(publication.observedAt) < Date.parse(lastStatic.observedAt)) {
      blockers.push({ taskId: "deploy", reason: "Publication predates completed source-artifact preflight." });
    }
  }
  return { allowed: blockers.length === 0, blockers };
}

/** Published readiness needs actual provider status AND anonymous public-page observations. */
export function evaluatePublishedGate(plan: StorefrontPlan, entries: TaskEvidence[], replId: string, now = new Date()): DeploymentGate {
  const blockers = [...evaluateTaskGate(plan, entries, replId, "qa", now).blockers];
  const deploy = currentEvidence(plan, entries, replId, "deploy", now);
  const publication = deploy.find(entry => entry.source === "provider-publish-status");
  const browser = deploy.find(entry => entry.source === "browser-check");
  if (!publication || publication.outcome !== "passed" || !publication.checks.includes("provider-published")) {
    blockers.push({ taskId: "deploy", reason: "Genuine provider-published evidence missing or failed." });
  }
  if (!browser || browser.outcome !== "passed" || !["anonymous-public-url", "correct-live-business-catalog"].every(check => browser.checks.includes(check))) {
    blockers.push({ taskId: "deploy", reason: "Anonymous public URL and live catalog identity evidence missing or failed." });
  }
  if (publication && browser && Date.parse(browser.observedAt) < Date.parse(publication.observedAt)) {
    blockers.push({ taskId: "deploy", reason: "Public verification must follow provider publication." });
  }
  const qa = currentEvidence(plan, entries, replId, "qa", now)[0];
  if (browser && qa && Date.parse(browser.observedAt) < Date.parse(qa.observedAt)) {
    blockers.push({ taskId: "deploy", reason: "Final public verification predates completed rendered QA." });
  }
  return { allowed: blockers.length === 0, blockers };
}
