import {
  buildReplitCreationPrompt, buildTaskPrompt, createStorefrontPlan, evaluateDeploymentGate,
  type ApprovedMerchantBrief, type StorefrontPlan, type StorefrontTask, type TaskEvidence,
  assertPlanIntegrity, validateTaskEvidence, evaluateTaskGate, evaluatePublishedGate,
} from "../orchestrator";

export type OwnerApproval = { ownerUserId: string; businessId: string; approvalId: string };
export type RunPhase = "queued" | "dispatching" | "awaiting_task" | "ready_to_publish" | "publishing" | "verifying" | "ready" | "blocked" | "failed";
export type BuildRun = {
  id: string;
  approval: OwnerApproval;
  plan: StorefrontPlan;
  phase: RunPhase;
  replId: string | null;
  currentTaskId: StorefrontTask["id"] | null;
  evidence: TaskEvidence[];
  publicUrl: string | null;
  candidateUrl: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  waitingSince: string | null;
  verificationChecks: string[];
  verificationAttempts: number;
  verifiedAt: string | null;
  verifiedCatalogRevision: number | null;
  verifiedHttpStatus: number | null;
};

export interface BuildRunStore {
  load(id: string): Promise<BuildRun | null>;
  save(run: BuildRun): Promise<void>;
  withLock<T>(id: string, action: () => Promise<T>): Promise<T>;
  reserveBusiness(businessId: string, runId: string): Promise<void>;
  releaseBusiness(businessId: string, runId: string): Promise<void>;
}

export type TaskObservation =
  | { state: "pending" }
  | { state: "blocked" | "failed"; code: string }
  | { state: "passed"; evidence: TaskEvidence };
export type PublishObservation =
  | { state: "pending" }
  | { state: "blocked" | "failed"; code: string }
  | { state: "ready"; publicUrl: string };

export interface ReplitBuildPort {
  createApp(prompt: string): Promise<{ replId: string }>;
  updateApp(replId: string, prompt: string): Promise<void>;
  observeTask(run: BuildRun, task: StorefrontTask): Promise<TaskObservation>;
  publishApp(replId: string): Promise<void>;
  observePublish(replId: string): Promise<PublishObservation>;
}

export interface PublicationAuthorization {
  /** Must verify owner, explicit publication approval, and immutable approved snapshot. Never trust model flags. */
  getApprovedBrief(approval: OwnerApproval): Promise<ApprovedMerchantBrief>;
}

export interface StorefrontVerifier {
  verify(url: string, plan: StorefrontPlan, replId: string): Promise<{ passed: boolean; checks: string[]; evidence: TaskEvidence[]; retryable?: boolean; catalogRevision?: number; httpStatus?: number }>;
}

/** One step per durable worker tick. No parallel writes to a Replit app, no mutation replay after ambiguous outcomes. */
export class PublicationWorkflow {
  constructor(
    private readonly store: BuildRunStore,
    private readonly authorization: PublicationAuthorization,
    private readonly replit: ReplitBuildPort,
    private readonly verifier: StorefrontVerifier,
    private readonly now = () => new Date(),
    private readonly waitTimeoutMs = 20 * 60_000,
  ) {}

  /** Retry only an independently read-only source observation on the known app.
   * Never use this to reconcile an uncertain create/update/publish outcome. */
  async resumeSourceObservation(id: string, approval: OwnerApproval): Promise<BuildRun> {
    return this.store.withLock(id, async () => {
      const run = await this.store.load(id);
      if (!run || run.approval.ownerUserId !== approval.ownerUserId || run.approval.businessId !== approval.businessId || run.approval.approvalId !== approval.approvalId) throw new Error("RUN_OWNERSHIP_MISMATCH");
      if (run.phase !== "blocked" || !["SOURCE_PREFLIGHT_UNVERIFIED", "SOURCE_PREFLIGHT_INCOMPLETE", "PROVIDER_IDLE_RESPONSE_UNVERIFIED"].includes(run.errorCode ?? "") || !run.replId || !["design", "frontend", "catalogIntegration"].includes(run.currentTaskId ?? "")) throw new Error("SOURCE_OBSERVATION_NOT_RETRYABLE");
      assertPlanIntegrity(run.plan);
      const approved = createStorefrontPlan(await this.authorization.getApprovedBrief(approval));
      if (approved.snapshotHash !== run.plan.snapshotHash) throw new Error("APPROVAL_SNAPSHOT_CHANGED");
      await this.store.reserveBusiness(run.approval.businessId, id);
      const timestamp = this.now().toISOString();
      const resumed: BuildRun = { ...run, phase: "awaiting_task", errorCode: null, updatedAt: timestamp };
      await this.store.save(resumed);
      return resumed;
    });
  }

  async enqueue(id: string, approval: OwnerApproval): Promise<BuildRun> {
    const brief = await this.authorization.getApprovedBrief(approval);
    const plan = createStorefrontPlan(brief);
    if (brief.businessId !== approval.businessId) throw new Error("APPROVAL_BUSINESS_MISMATCH");
    return this.store.withLock(id, async () => {
      const existing = await this.store.load(id);
      if (existing) {
        if (existing.approval.ownerUserId !== approval.ownerUserId || existing.approval.businessId !== approval.businessId || existing.approval.approvalId !== approval.approvalId || existing.plan.snapshotHash !== plan.snapshotHash) {
          throw new Error("IDEMPOTENCY_CONFLICT");
        }
        return existing;
      }
      const timestamp = this.now().toISOString();
      const run: BuildRun = { id, approval, plan, phase: "queued", replId: null, currentTaskId: null, evidence: [], publicUrl: null, candidateUrl: null, errorCode: null, createdAt: timestamp, updatedAt: timestamp, waitingSince: null, verificationChecks: [], verificationAttempts: 0, verifiedAt: null, verifiedCatalogRevision: null, verifiedHttpStatus: null };
      await this.store.reserveBusiness(approval.businessId, id);
      try { await this.store.save(run); }
      catch (error) { await this.store.releaseBusiness(approval.businessId, id); throw error; }
      return run;
    });
  }

  async step(id: string): Promise<BuildRun> {
    return this.store.withLock(id, async () => {
      const run = await this.store.load(id);
      if (!run) throw new Error("RUN_NOT_FOUND");
      if (["ready", "failed", "blocked"].includes(run.phase)) return run;
      const save = async (patch: Partial<BuildRun>) => {
        Object.assign(run, patch, { updatedAt: this.now().toISOString() });
        await this.store.save(run);
        if (run.phase === "ready" || run.phase === "failed") await this.store.releaseBusiness(run.approval.businessId, run.id);
        return run;
      };
      // A process died between persisted mutation intent and outcome. Never blindly repeat it.
      if (run.phase === "dispatching") return save({ phase: "blocked", errorCode: "REMOTE_OUTCOME_UNKNOWN" });

      try {
        assertPlanIntegrity(run.plan);
        const approved = createStorefrontPlan(await this.authorization.getApprovedBrief(run.approval));
        if (approved.snapshotHash !== run.plan.snapshotHash) return save({ phase: "blocked", errorCode: "APPROVAL_SNAPSHOT_CHANGED" });
        const tasks = run.plan.tasks.filter(task => task.id !== "deploy" && task.id !== "qa");
        if (run.phase === "queued") {
          await save({ phase: "dispatching", currentTaskId: tasks[0].id });
          const result = await this.replit.createApp(buildReplitCreationPrompt(run.plan));
          if (!result.replId) return save({ phase: "blocked", errorCode: "CREATION_ID_UNVERIFIED" });
          return save({ replId: result.replId, phase: "awaiting_task", waitingSince: this.now().toISOString() });
        }
        if (!run.replId) return save({ phase: "blocked", errorCode: "REPLIT_ID_MISSING" });

        if (run.phase === "awaiting_task") {
          if (run.waitingSince && this.now().getTime() - Date.parse(run.waitingSince) > this.waitTimeoutMs) return save({ phase: "blocked", errorCode: "TASK_TIMEOUT_RECONCILE" });
          const task = tasks.find(task => task.id === run.currentTaskId);
          if (!task) return save({ phase: "blocked", errorCode: "TASK_STATE_INVALID" });
          const observation = await this.replit.observeTask(run, task);
          if (observation.state === "pending") return run;
          if (observation.state !== "passed") return save({ phase: observation.state, errorCode: observation.code });
          const evidence = validateTaskEvidence(observation.evidence);
          if (evidence.planId !== run.plan.id || evidence.taskId !== task.id || evidence.replId !== run.replId || evidence.outcome !== "passed" || Date.parse(evidence.observedAt) < Date.parse(run.waitingSince ?? run.createdAt)) {
            return save({ phase: "blocked", errorCode: "TASK_EVIDENCE_MISMATCH" });
          }
          if (!evaluateTaskGate(run.plan, [...run.evidence, evidence], run.replId, task.id as Exclude<StorefrontTask["id"], "deploy">, this.now()).allowed) {
            return save({ phase: "blocked", errorCode: "TASK_ACCEPTANCE_FAILED" });
          }
          await save({ evidence: [...run.evidence, evidence] });
          const next = tasks[tasks.indexOf(task) + 1];
          if (!next) {
            const gate = evaluateDeploymentGate(run.plan, run.evidence, run.replId, this.now());
            if (!gate.allowed) return save({ phase: "blocked", errorCode: "DEPLOYMENT_GATE_FAILED" });
            return save({ phase: "ready_to_publish", currentTaskId: "deploy", waitingSince: null });
          }
          await save({ phase: "dispatching", currentTaskId: next.id });
          await this.replit.updateApp(run.replId, buildTaskPrompt(run.plan, next.id));
          return save({ phase: "awaiting_task", waitingSince: this.now().toISOString() });
        }
        if (run.phase === "ready_to_publish") {
          const gate = evaluateDeploymentGate(run.plan, run.evidence, run.replId, this.now());
          if (!gate.allowed) return save({ phase: "blocked", errorCode: "DEPLOYMENT_GATE_FAILED" });
          await save({ phase: "dispatching" });
          await this.replit.publishApp(run.replId);
          return save({ phase: "publishing", waitingSince: this.now().toISOString() });
        }
        if (run.phase === "publishing") {
          if (run.waitingSince && this.now().getTime() - Date.parse(run.waitingSince) > this.waitTimeoutMs) return save({ phase: "blocked", errorCode: "PUBLISH_TIMEOUT_RECONCILE" });
          const result = await this.replit.observePublish(run.replId);
          if (result.state === "pending") return run;
          if (result.state !== "ready") return save({ phase: result.state, errorCode: result.code });
          const url = new URL(result.publicUrl);
          if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return save({ phase: "blocked", errorCode: "INVALID_PUBLIC_URL" });
          const publicationEvidence: TaskEvidence = { planId: run.plan.id, taskId: "deploy", replId: run.replId, source: "provider-publish-status", outcome: "passed", observedAt: this.now().toISOString(), artifactRef: url.href, checks: ["provider-published"] };
          return save({ phase: "verifying", currentTaskId: "qa", candidateUrl: url.href, evidence: [...run.evidence, publicationEvidence], waitingSince: this.now().toISOString() });
        }
        if (run.phase === "verifying") {
          if (run.waitingSince && this.now().getTime() - Date.parse(run.waitingSince) > this.waitTimeoutMs) return save({ phase: "failed", errorCode: "VERIFICATION_TIMEOUT" });
          if (!run.candidateUrl) return save({ phase: "blocked", errorCode: "PUBLIC_URL_MISSING" });
          const qa = run.plan.tasks.find(task => task.id === "qa")!;
          const qaObservation = await this.replit.observeTask(run, qa);
          if (qaObservation.state === "pending") return run;
          if (qaObservation.state !== "passed") return save({ phase: qaObservation.state, errorCode: qaObservation.code });
          const qaEvidence = validateTaskEvidence(qaObservation.evidence);
          if (!evaluateTaskGate(run.plan, [...run.evidence, qaEvidence], run.replId, "qa", this.now()).allowed) return save({ phase: "failed", errorCode: "POST_PUBLICATION_QA_FAILED" });
          const proof = await this.verifier.verify(run.candidateUrl, run.plan, run.replId);
          if (!proof.passed && proof.retryable && run.verificationAttempts < 3) {
            return save({ verificationAttempts: run.verificationAttempts + 1, verificationChecks: proof.checks, errorCode: "PUBLIC_VERIFICATION_RETRY_PENDING" });
          }
          const evidence = [...run.evidence, qaEvidence, ...proof.evidence.map(validateTaskEvidence)];
          const required = ["anonymous-public-url", "correct-live-business-catalog", "current-product-prices-stock", "usable-original-images", "same-origin-live-catalog-proxy"];
          const accepted = proof.passed && Number.isInteger(proof.httpStatus) && proof.httpStatus! >= 200 && proof.httpStatus! <= 299 && Number.isSafeInteger(proof.catalogRevision) && proof.catalogRevision! >= run.plan.brief.catalogRevision && required.every(check => proof.checks.includes(check)) && evaluatePublishedGate(run.plan, evidence, run.replId, this.now()).allowed;
          return accepted
            ? save({ phase: "ready", publicUrl: run.candidateUrl, evidence, verificationChecks: proof.checks, verifiedAt: this.now().toISOString(), verifiedCatalogRevision: proof.catalogRevision!, verifiedHttpStatus: proof.httpStatus!, errorCode: null })
            : save({ phase: "failed", errorCode: "PUBLIC_VERIFICATION_FAILED", evidence, verificationChecks: proof.checks });
        }
        return save({ phase: "blocked", errorCode: "UNRECOGNIZED_STATE" });
      } catch {
        // Error messages can contain provider payloads or credentials. Persist a safe code only.
        return save({ phase: "blocked", errorCode: (run as BuildRun).phase === "dispatching" ? "REMOTE_OUTCOME_UNKNOWN" : "INTEGRATION_CHECK_FAILED" });
      }
    });
  }
}
