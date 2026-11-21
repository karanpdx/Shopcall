import type Database from "better-sqlite3";
import { z } from "zod";
import type { BuildJob, BuildSpec, BuildJobUpdate } from "../../contracts/api";
import type { SqliteRepository } from "../../server/repository";
import type { OwnerApproval, PublicationAuthorization } from "../publication/workflow";
import type { VerifiedOwnerDirectory } from "../publication/notifications";
import { fail } from "../../server/http";

const specSchema = z.object({ jobId: z.uuid(), businessId: z.uuid(), businessName: z.string().min(1), slug: z.string().min(1), publicCatalogUrl: z.url(), catalogRevision: z.number().int().nonnegative(), designBrief: z.string(), approvedByOwnerId: z.uuid(), approvedAt: z.iso.datetime() }).strict();
export interface BackendJobSource extends PublicationAuthorization, VerifiedOwnerDirectory {
  getJob(jobId: string): Promise<BuildJob | null>;
  getSpec(jobId: string): Promise<BuildSpec | null>;
  claimOrRecover(): Promise<BuildJob | null>;
  updateJob(jobId: string, update: BuildJobUpdate): Promise<BuildJob>;
  assertOwnerJob(ownerId: string, businessId: string, jobId: string): Promise<BuildJob>;
}

/** Uses B's frozen approved specs and recovers already-claimed jobs deterministically. */
export class SqliteBackendJobSource implements BackendJobSource {
  constructor(private readonly db: Database.Database, private readonly repo: SqliteRepository, private readonly demoEmail = process.env.DEMO_OWNER_EMAIL) {}
  async getJob(jobId: string) {
    if (!z.uuid().safeParse(jobId).success) return null;
    const row = this.db.prepare("SELECT business_id AS businessId FROM build_jobs WHERE id=?").get(jobId) as { businessId: string } | undefined;
    return row ? this.repo.getBuildJob(row.businessId, jobId) : null;
  }
  async getSpec(jobId: string) { const spec = await this.repo.getBuildSpec(jobId); return spec ? specSchema.parse(spec) : null; }
  async claimOrRecover() {
    const row = this.db.prepare("SELECT id FROM build_jobs WHERE build_status='running' OR (build_status='completed' AND publication_status='pending') ORDER BY created_at,id LIMIT 1").get() as { id: string } | undefined;
    return row ? this.getJob(row.id) : (await this.repo.claimNextBuildJob())?.job ?? null;
  }
  updateJob(jobId: string, update: BuildJobUpdate) { return this.repo.updateBuildJob(jobId, update); }
  async assertOwnerJob(ownerId: string, businessId: string, jobId: string) {
    const business = await this.repo.getBusiness(businessId); const job = await this.repo.getBuildJob(businessId, jobId);
    if (!business || business.ownerId !== ownerId || !job) return fail(404, "NOT_FOUND", "Build job not found.");
    return job;
  }
  async getApprovedBrief(approval: OwnerApproval) {
    const spec = await this.getSpec(approval.approvalId);
    if (!spec || spec.jobId !== approval.approvalId || spec.businessId !== approval.businessId || spec.approvedByOwnerId !== approval.ownerUserId) throw new Error("APPROVED_BUILD_SNAPSHOT_REQUIRED");
    await this.assertOwnerJob(approval.ownerUserId, approval.businessId, approval.approvalId);
    return { businessId: spec.businessId, businessName: spec.businessName, publicCatalogUrl: spec.publicCatalogUrl, catalogRevision: spec.catalogRevision, approvedDesignBrief: spec.designBrief.trim() || "No specific visual style was requested. Use a simple, accessible, mobile-friendly storefront." };
  }
  async getVerifiedOwnerEmail(ownerUserId: string, businessId: string): Promise<string | null> {
    const row = this.db.prepare("SELECT o.email FROM owners o JOIN businesses b ON b.owner_id=o.id WHERE o.id=? AND b.id=?").get(ownerUserId, businessId) as { email: string } | undefined;
    // Canonical configured demo identity, not independent email inbox verification.
    const configured = [this.demoEmail, process.env.DEMO_SECOND_OWNER_EMAIL].filter((value): value is string => !!value).map(value => value.toLowerCase());
    return row && configured.includes(row.email.toLowerCase()) ? row.email : null;
  }
}
