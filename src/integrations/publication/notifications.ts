import type { BuildRunStore } from "./workflow";
import { evaluatePublishedGate } from "../orchestrator";
import { enqueuePublicationReadyEmail, processNotificationOutbox, refreshNotificationDeliveryStatus, type NotificationDeps, type ResendClient, type VerifiedPublicationSource } from "../notifications";

export interface VerifiedOwnerDirectory {
  /** Resolve from canonical server-side ownership records. Return null for unverified/mismatched owner. */
  getVerifiedOwnerEmail(ownerUserId: string, businessId: string): Promise<string | null>;
}

/** Bridges C's actual persisted proof to notifications without extending B's shared BuildJob type. */
export class WorkflowPublicationSource implements VerifiedPublicationSource {
  constructor(private readonly runs: BuildRunStore, private readonly owners: VerifiedOwnerDirectory) {}

  async getPublication(jobId: string) {
    const run = await this.runs.load(jobId);
    if (!run) return null;
    if (run.phase !== "ready" || !run.publicUrl || run.candidateUrl !== run.publicUrl || !run.replId || !run.verifiedAt || run.verifiedCatalogRevision === null || run.verifiedHttpStatus === null) return { phase: run.phase === "ready" ? "unverified" : run.phase };
    // Proof remains an immutable historical observation; don't make it appear newly observed.
    if (!evaluatePublishedGate(run.plan, run.evidence, run.replId, new Date(run.verifiedAt)).allowed) return { phase: "unverified" };
    const ownerEmail = await this.owners.getVerifiedOwnerEmail(run.approval.ownerUserId, run.approval.businessId);
    if (!ownerEmail) return { phase: "unverified" };
    return {
      jobId: run.id, businessId: run.plan.brief.businessId, businessName: run.plan.brief.businessName,
      ownerEmail, phase: "ready", publicUrl: run.publicUrl, catalogRevision: run.verifiedCatalogRevision,
      verification: { verifiedAt: run.verifiedAt, verifiedUrl: run.publicUrl, httpStatus: run.verifiedHttpStatus, businessIdMatched: true, catalogRevisionMatched: true },
    };
  }
}

/** Called by deployment worker only after workflow step. Configuration/sending is explicit, never from model tools. */
export class PublicationNotificationWorker {
  constructor(private readonly deps: NotificationDeps & { sender: { from: string; replyTo?: string }; resend: ResendClient }) {}
  async step(jobId: string) {
    const queued = await enqueuePublicationReadyEmail(this.deps, { jobId });
    if (!queued.ok) return { queued: false, code: queued.error.code };
    const sending = await processNotificationOutbox(this.deps, { limit: 10 });
    const delivery = await refreshNotificationDeliveryStatus(this.deps, { limit: 25 });
    return { queued: true, sending, delivery };
  }
}
