import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { WorkspaceOwner, WorkingProductDraft } from "../call-workspace/store";

export type MediaStageStatus = "queued" | "running" | "ready" | "failed" | "interrupted" | "stale";
export type ProductMediaJob = {
  id: string; ownerId: string; businessId: string; callId: string; productDraftId: string; originalAssetId: string; capturedAt: string;
  sourceDraftRevision: number; sourceTitle: string | null; sourceDescription: string | null;
  enhancedAssetId: string | null; analysisStatus: MediaStageStatus; enhancementStatus: MediaStageStatus;
  suggestedTitle: string | null; suggestedDescription: string | null; selectedVariant: "original" | "enhanced"; titleApplied: boolean; descriptionApplied: boolean;
  analysisModel: string | null; enhancementModel: string | null; analysisStartedAt: string | null; analysisCompletedAt: string | null;
  enhancementStartedAt: string | null; enhancementCompletedAt: string | null; errorCode: string | null;
  leaseToken: string | null; leaseExpiresAt: string | null; createdAt: string; updatedAt: string;
};
type StoredRow = { record: string };
const TABLE = "shopcall_product_media_v1";

/** Additive metadata in B's same durable DB. Images remain separate B-owned assets/blobs. */
export class ProductMediaStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,ownerId TEXT NOT NULL,businessId TEXT NOT NULL,callId TEXT NOT NULL,
      draftId TEXT NOT NULL,originalAssetId TEXT NOT NULL,capturedAt TEXT NOT NULL,
      record TEXT NOT NULL CHECK(json_valid(record)),UNIQUE(draftId,originalAssetId,capturedAt)
    ); CREATE INDEX IF NOT EXISTS shopcall_product_media_draft_v1 ON ${TABLE}(draftId);`);
  }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  private read(raw: unknown): ProductMediaJob | null { return raw ? JSON.parse((raw as StoredRow).record) as ProductMediaJob : null; }
  get(id: string): ProductMediaJob | null { return this.read(this.db.prepare(`SELECT record FROM ${TABLE} WHERE id=?`).get(id)); }
  forDraft(draftId: string): ProductMediaJob[] { return this.db.prepare(`SELECT record FROM ${TABLE} WHERE draftId=? ORDER BY rowid DESC`).all(draftId).map(row => this.read(row)!); }
  private save(job: ProductMediaJob) { this.db.prepare(`UPDATE ${TABLE} SET record=? WHERE id=?`).run(JSON.stringify(job), job.id); }
  enqueue(owner: WorkspaceOwner, draft: WorkingProductDraft, now: Date): ProductMediaJob {
    if (!draft.imageAssetId || !draft.capturedAt) throw new Error("ORIGINAL_CAPTURE_REQUIRED");
    return this.transaction(() => {
      const found = this.read(this.db.prepare(`SELECT record FROM ${TABLE} WHERE draftId=? AND originalAssetId=? AND capturedAt=?`).get(draft.id, draft.imageAssetId, draft.capturedAt));
      if (found) return found;
      const ts = now.toISOString();
      const callCount = (this.db.prepare(`SELECT COUNT(*) AS count FROM ${TABLE} WHERE callId=?`).get(draft.callId) as { count: number }).count;
      const dayCount = (this.db.prepare(`SELECT COUNT(*) AS count FROM ${TABLE} WHERE businessId=? AND json_extract(record,'$.createdAt')>=?`).get(owner.businessId, `${ts.slice(0, 10)}T00:00:00.000Z`) as { count: number }).count;
      const limited = callCount >= 8 || dayCount >= 30;
      const job: ProductMediaJob = { id: randomUUID(), ownerId: owner.ownerId, businessId: owner.businessId, callId: draft.callId, productDraftId: draft.id,
        originalAssetId: draft.imageAssetId!, capturedAt: draft.capturedAt!, sourceDraftRevision: draft.revision, sourceTitle: draft.fields.title ?? null, sourceDescription: draft.fields.description ?? null,
        enhancedAssetId: null, analysisStatus: limited ? "failed" : "queued", enhancementStatus: limited ? "failed" : "queued", suggestedTitle: null, suggestedDescription: null, selectedVariant: "original", titleApplied: false, descriptionApplied: false,
        analysisModel: null, enhancementModel: null, analysisStartedAt: null, analysisCompletedAt: null, enhancementStartedAt: null, enhancementCompletedAt: null, errorCode: limited ? "MEDIA_LIMIT_REACHED" : null, leaseToken: null, leaseExpiresAt: null, createdAt: ts, updatedAt: ts };
      this.db.prepare(`INSERT INTO ${TABLE}(id,ownerId,businessId,callId,draftId,originalAssetId,capturedAt,record) VALUES(?,?,?,?,?,?,?,?)`).run(job.id, job.ownerId, job.businessId, job.callId, job.productDraftId, job.originalAssetId, job.capturedAt, JSON.stringify(job));
      return job;
    });
  }
  claimNext(now: Date, leaseMs = 10 * 60_000): ProductMediaJob | null {
    return this.transaction(() => {
      const jobs = this.db.prepare(`SELECT record FROM ${TABLE} ORDER BY rowid`).all().map(row => this.read(row)!);
      for (const job of jobs) {
        if (job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) <= now.getTime()) {
          if (job.analysisStatus === "running") { job.analysisStatus = "interrupted"; job.errorCode = "ANALYSIS_OUTCOME_UNKNOWN"; }
          if (job.enhancementStatus === "running") { job.enhancementStatus = "interrupted"; job.errorCode = "ENHANCEMENT_OUTCOME_UNKNOWN"; }
          job.leaseToken = null; job.leaseExpiresAt = null; job.updatedAt = now.toISOString(); this.save(job);
        }
      }
      const job = jobs.find(item => !item.leaseToken && (item.analysisStatus === "queued" || item.enhancementStatus === "queued"));
      if (!job) return null;
      job.leaseToken = randomUUID(); job.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString(); job.updatedAt = now.toISOString(); this.save(job);
      return structuredClone(job);
    });
  }
  patchClaim(id: string, token: string, patch: Partial<ProductMediaJob>, now: Date): ProductMediaJob | null {
    return this.transaction(() => {
      const job = this.get(id);
      if (!job || job.leaseToken !== token || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= now.getTime()) return null;
      Object.assign(job, patch, { updatedAt: now.toISOString() }); this.save(job); return job;
    });
  }
  release(id: string, token: string, now: Date) { return this.patchClaim(id, token, { leaseToken: null, leaseExpiresAt: null }, now); }
  recordChoice(id: string, fields: Pick<ProductMediaJob, "selectedVariant" | "titleApplied" | "descriptionApplied">, now: Date) {
    const job = this.get(id); if (!job) throw new Error("MEDIA_JOB_NOT_FOUND");
    Object.assign(job, fields, { updatedAt: now.toISOString() }); this.save(job); return job;
  }
}
