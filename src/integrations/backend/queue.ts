import { z } from "zod";
import { evaluatePublishedGate } from "../orchestrator";
import type { BuildRun, BuildRunStore, PublicationWorkflow } from "../publication/workflow";
import type { PublicationNotificationWorker } from "../publication/notifications";
import type { BackendJobSource } from "./source";

export type RuntimeConnection = { workflow: Pick<PublicationWorkflow, "enqueue" | "step">; notifications?: Pick<PublicationNotificationWorker, "step">; close(): Promise<void> };
export type BackendTick = { jobId: string | null; phase: string; task?: string | null; errorCode?: string | null; notification?: unknown };
export class BackendConfigurationError extends Error { constructor(readonly code: string) { super(code); this.name = "BackendConfigurationError"; } }

export class BackendQueueRuntime {
  constructor(private readonly source: BackendJobSource, private readonly runs: BuildRunStore, private readonly connect: (ownerId: string) => Promise<RuntimeConnection>) {}
  async tick(options: { runId?: string } = {}): Promise<BackendTick> {
    if (options.runId) z.uuid().parse(options.runId);
    let job = options.runId ? await this.source.getJob(options.runId) : await this.source.claimOrRecover();
    if (!job) return { jobId: options.runId ?? null, phase: options.runId ? "not_found" : "idle" };
    let spec;
    try { spec = await this.source.getSpec(job.id); } catch { return { jobId: job.id, phase: "blocked", errorCode: "APPROVED_BUILD_SNAPSHOT_INVALID" }; }
    if (!spec || spec.jobId !== job.id || spec.businessId !== job.businessId) return { jobId: job.id, phase: "blocked", errorCode: "APPROVED_BUILD_SNAPSHOT_REQUIRED" };
    const approval = { ownerUserId: spec.approvedByOwnerId, businessId: spec.businessId, approvalId: job.id };
    try { await this.source.getApprovedBrief(approval); } catch { return { jobId: job.id, phase: "blocked", errorCode: "APPROVED_BUILD_SNAPSHOT_REQUIRED" }; }
    if (job.buildStatus === "failed" || job.publicationStatus === "failed") return { jobId: job.id, phase: "failed", errorCode: "BUILD_JOB_ALREADY_FAILED" };
    const existing = await this.runs.load(job.id);
    if (job.publicationStatus === "completed" && !existing) return { jobId: job.id, phase: "blocked", errorCode: "PUBLISHED_RUN_STATE_MISSING_RECONCILE" };
    let connection: RuntimeConnection | undefined;
    try {
      connection = await this.connect(approval.ownerUserId);
      if (job.buildStatus === "queued") job = await this.source.updateJob(job.id, { buildStatus: "running" });
      if (!existing) await connection.workflow.enqueue(job.id, approval);
      else if (existing.approval.ownerUserId !== approval.ownerUserId || existing.approval.businessId !== approval.businessId || existing.approval.approvalId !== job.id) throw new Error("RUN_OWNERSHIP_MISMATCH");
      const run = await connection.workflow.step(job.id);
      await this.mirror(job.id, run);
      let notification: unknown = "not_configured";
      if (run.phase === "ready" && connection.notifications) {
        try { notification = await connection.notifications.step(job.id); }
        catch { notification = { queued: false, code: "NOTIFICATION_PROCESSING_FAILED" }; }
      }
      return { jobId: job.id, phase: run.phase, task: run.currentTaskId, errorCode: run.errorCode, ...(run.phase === "ready" ? { notification } : {}) };
    } catch (error) {
      const busy = error instanceof Error && /^RUN_LOCKED/.test(error.message);
      const code = busy ? "WORKER_BUSY_RETRY" : error instanceof BackendConfigurationError ? error.code : "BACKEND_RUNTIME_NOT_READY";
      if (!busy) await this.source.updateJob(job.id, { errorMessage: code }).catch(() => {});
      return { jobId: job.id, phase: busy ? "busy" : "blocked", errorCode: code };
    } finally { await connection?.close().catch(() => {}); }
  }
  private async mirror(jobId: string, run: BuildRun) {
    if (run.id !== jobId) throw new Error("RUN_ID_MISMATCH");
    const job = await this.source.getJob(jobId);
    if (!job || job.businessId !== run.approval.businessId) throw new Error("RUN_BUSINESS_MISMATCH");
    const base = { ...(run.replId ? { providerJobId: run.replId } : {}), errorMessage: run.errorCode ?? "" };
    if (run.phase === "ready") {
      if (!run.replId || !run.publicUrl || run.publicUrl !== run.candidateUrl || !run.verifiedAt || !Number.isInteger(run.verifiedHttpStatus) || run.verifiedHttpStatus! < 200 || run.verifiedHttpStatus! > 299 || !Number.isSafeInteger(run.verifiedCatalogRevision) || run.verifiedCatalogRevision! < run.plan.brief.catalogRevision || !evaluatePublishedGate(run.plan, run.evidence, run.replId, new Date(run.verifiedAt)).allowed || !run.evidence.some(evidence => evidence.taskId === "deploy" && evidence.source === "browser-check" && evidence.artifactRef === run.publicUrl)) throw new Error("PUBLICATION_PROOF_REQUIRED");
      await this.source.updateJob(jobId, { ...base, buildStatus: "completed", publicationStatus: "completed", publicUrl: run.publicUrl });
    } else if (run.phase === "failed") await this.source.updateJob(jobId, { ...base, ...(job.buildStatus === "completed" ? { publicationStatus: "failed" as const } : { buildStatus: "failed" as const }) });
    else if (["publishing", "verifying"].includes(run.phase)) await this.source.updateJob(jobId, { ...base, buildStatus: "completed" });
    else await this.source.updateJob(jobId, { ...base, ...(job.buildStatus === "queued" ? { buildStatus: "running" as const } : {}) });
  }
}
