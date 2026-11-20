import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { Asset } from "../../contracts/api";
import { fail } from "../../server/http";
import type { BlobStore } from "../../server/storage";
import { CallWorkspaceStore, type WorkspaceOwner, type WorkingProductDraft } from "../call-workspace/store";
import { ProductMediaStore, type ProductMediaJob } from "./store";

export interface ProductMediaProvider {
  analyze(input: { bytes: Uint8Array; mimeType: string; title?: string; description?: string }): Promise<{ title: string; description: string; model: string }>;
  enhance(input: { bytes: Uint8Array; mimeType: string }): Promise<{ bytes: Uint8Array; mimeType: string; model: string }>;
}
export interface ProductMediaAssets {
  getAssetForServing(id: string): { businessId: string; storageKey: string; mimeType: Asset["mimeType"]; isPublic: boolean } | null;
  createAsset(input: { id: string; businessId: string; storageKey: string; mimeType: Asset["mimeType"]; sizeBytes: number; width: number; height: number }): Asset;
}
const analysis = z.object({ title: z.string().trim().min(1).max(160), description: z.string().trim().min(1).max(4000), model: z.string().min(1).max(200) }).strict();
export const mediaChoice = z.object({ jobId: z.uuid(), expectedDraftRevision: z.number().int().positive(), applyTitle: z.boolean().optional(), applyDescription: z.boolean().optional(), useEnhanced: z.boolean().optional() }).strict().refine(value => value.applyTitle || value.applyDescription || value.useEnhanced !== undefined, "Choose at least one suggestion or image variant.");
export type MediaChoice = z.infer<typeof mediaChoice>;

export class ProductMediaService {
  constructor(readonly store: ProductMediaStore, private readonly workspace: CallWorkspaceStore, private readonly assets: ProductMediaAssets, private readonly storage: () => BlobStore, private readonly now: () => Date = () => new Date()) {}
  private matches(job: ProductMediaJob, draft: WorkingProductDraft) { return draft.capturedAt === job.capturedAt && (draft.imageAssetId === job.originalAssetId || !!job.enhancedAssetId && draft.imageAssetId === job.enhancedAssetId); }
  private owned(owner: WorkspaceOwner, callId: string, draftId: string, jobId: string) {
    const draft = this.workspace.getDraft(owner, callId, draftId); const job = this.store.get(jobId);
    if (!job || job.ownerId !== owner.ownerId || job.businessId !== owner.businessId || job.callId !== callId || job.productDraftId !== draftId) return fail(404, "NOT_FOUND", "Product media job not found.");
    return { draft, job };
  }
  private project(job: ProductMediaJob, draft: WorkingProductDraft) {
    // These are authenticated owner previews. Same-origin paths preserve the
    // session cookie even when PUBLIC_API_BASE is a separate storefront/tunnel host.
    return { id: job.id, productDraftId: job.productDraftId, originalAssetId: job.originalAssetId, originalUrl: `/api/assets/${job.originalAssetId}`, enhancedAssetId: job.enhancedAssetId, enhancedUrl: job.enhancedAssetId ? `/api/assets/${job.enhancedAssetId}` : null,
      sourceDraftRevision: job.sourceDraftRevision, currentDraftRevision: draft.revision, analysisStatus: this.matches(job, draft) ? job.analysisStatus : "stale", enhancementStatus: this.matches(job, draft) ? job.enhancementStatus : "stale",
      selectedVariant: draft.imageAssetId === job.enhancedAssetId ? "enhanced" : "original", suggestedTitle: job.suggestedTitle, suggestedDescription: job.suggestedDescription,
      titleApplied: job.titleApplied, descriptionApplied: job.descriptionApplied, errorCode: job.errorCode,
      evidence: { analysisModel: job.analysisModel, enhancementModel: job.enhancementModel, analysisStartedAt: job.analysisStartedAt, analysisCompletedAt: job.analysisCompletedAt, enhancementStartedAt: job.enhancementStartedAt, enhancementCompletedAt: job.enhancementCompletedAt }, createdAt: job.createdAt, updatedAt: job.updatedAt };
  }
  getForDraft(owner: WorkspaceOwner, callId: string, draftId: string) {
    const draft = this.workspace.getDraft(owner, callId, draftId);
    const jobs = this.store.forDraft(draftId).filter(job => job.ownerId === owner.ownerId && job.businessId === owner.businessId && job.callId === callId);
    const job = jobs.find(item => this.matches(item, draft)) ?? jobs[0];
    return { job: job ? this.project(job, draft) : null };
  }
  enqueueForDraft(owner: WorkspaceOwner, callId: string, draftId: string) {
    const draft = this.workspace.getDraft(owner, callId, draftId);
    if (!draft.imageAssetId || !draft.capturedAt) return fail(409, "NOT_READY", "Capture or upload a product photo first.");
    const prior = this.store.forDraft(draftId).find(job => this.matches(job, draft));
    if (prior) return { job: this.project(prior, draft) };
    const original = this.assets.getAssetForServing(draft.imageAssetId);
    if (!original || original.businessId !== owner.businessId) return fail(404, "NOT_FOUND", "Original photo asset not found.");
    const job = this.store.enqueue(owner, draft, this.now());
    return { job: this.project(job, draft) };
  }
  applyChoice(owner: WorkspaceOwner, callId: string, draftId: string, raw: unknown) {
    const input = mediaChoice.parse(raw);
    return this.store.transaction(() => {
      const { job, draft } = this.owned(owner, callId, draftId, input.jobId);
      if (!this.matches(job, draft)) return fail(409, "STALE_REVISION", "This media result belongs to an older photo. Review the current capture.");
      if (input.applyTitle || input.applyDescription) { if (job.analysisStatus !== "ready") return fail(409, "NOT_READY", "Photo suggestions are not ready."); }
      if (input.useEnhanced && (job.enhancementStatus !== "ready" || !job.enhancedAssetId)) return fail(409, "NOT_READY", "Enhanced photo is not ready. Original remains available.");
      const updated = this.workspace.applyMediaSelection(owner, callId, draftId, {
        expectedRevision: input.expectedDraftRevision, originalAssetId: job.originalAssetId, enhancedAssetId: job.enhancedAssetId, capturedAt: job.capturedAt,
        ...(input.applyTitle ? { title: job.suggestedTitle!, expectedTitle: job.titleApplied ? job.suggestedTitle : job.sourceTitle } : {}),
        ...(input.applyDescription ? { description: job.suggestedDescription!, expectedDescription: job.descriptionApplied ? job.suggestedDescription : job.sourceDescription } : {}),
        ...(input.useEnhanced !== undefined ? { selectedAssetId: input.useEnhanced ? job.enhancedAssetId! : job.originalAssetId } : {}),
      });
      const saved = this.store.recordChoice(job.id, { selectedVariant: updated.imageAssetId === job.enhancedAssetId ? "enhanced" : "original", titleApplied: job.titleApplied || !!input.applyTitle, descriptionApplied: job.descriptionApplied || !!input.applyDescription }, this.now());
      return { draft: updated, job: this.project(saved, updated), saved: true, published: false };
    });
  }
  async processNext(provider: ProductMediaProvider) {
    let job = this.store.claimNext(this.now());
    if (!job) return { processed: false };
    const jobId = job.id;
    const token = job.leaseToken!;
    const owner = { ownerId: job.ownerId, businessId: job.businessId };
    const fresh = () => { try { return this.matches(job!, this.workspace.getDraft(owner, job!.callId, job!.productDraftId)); } catch { return false; } };
    const stale = () => this.store.patchClaim(job!.id, token, { analysisStatus: "stale", enhancementStatus: "stale", errorCode: "CAPTURE_REPLACED" }, this.now());
    try {
      if (!fresh()) { stale(); return { processed: true, jobId: job.id, state: "stale" }; }
      const original = this.assets.getAssetForServing(job.originalAssetId);
      if (!original || original.businessId !== job.businessId) throw new Error("ORIGINAL_ASSET_UNAVAILABLE");
      const bytes = await this.storage().get(original.storageKey);
      if (!bytes || bytes.byteLength > 20 * 1024 * 1024) throw new Error("ORIGINAL_BYTES_UNAVAILABLE");
      if (job.analysisStatus === "queued") {
        job = this.store.patchClaim(job.id, token, { analysisStatus: "running", analysisStartedAt: this.now().toISOString() }, this.now());
        if (!job) return { processed: true, state: "lease_lost" };
        try {
          const result = analysis.parse(await provider.analyze({ bytes, mimeType: original.mimeType, ...(job.sourceTitle ? { title: job.sourceTitle } : {}), ...(job.sourceDescription ? { description: job.sourceDescription } : {}) }));
          if (!fresh()) { stale(); return { processed: true, jobId: job.id, state: "stale" }; }
          job = this.store.patchClaim(job.id, token, { analysisStatus: "ready", suggestedTitle: result.title, suggestedDescription: result.description, analysisModel: result.model, analysisCompletedAt: this.now().toISOString() }, this.now());
        } catch { job = this.store.patchClaim(jobId, token, { analysisStatus: "failed", analysisCompletedAt: this.now().toISOString(), errorCode: "ANALYSIS_FAILED" }, this.now()); }
      }
      if (!job) return { processed: true, state: "lease_lost" };
      if (job.enhancementStatus === "queued") {
        if (!fresh()) { stale(); return { processed: true, jobId: job.id, state: "stale" }; }
        job = this.store.patchClaim(job.id, token, { enhancementStatus: "running", enhancementStartedAt: this.now().toISOString() }, this.now());
        if (!job) return { processed: true, state: "lease_lost" };
        try {
          const result = await provider.enhance({ bytes, mimeType: original.mimeType });
          if (!(result.bytes instanceof Uint8Array) || !result.bytes.byteLength || result.bytes.byteLength > 20 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(result.mimeType) || !z.string().min(1).max(200).safeParse(result.model).success) throw new Error("INVALID_ENHANCED_IMAGE");
          const meta = await sharp(result.bytes, { limitInputPixels: 25_000_000 }).metadata();
          const expectedFormat = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" }[result.mimeType];
          if (!meta.width || !meta.height || meta.format !== expectedFormat) throw new Error("INVALID_ENHANCED_IMAGE");
          if (!fresh()) { stale(); return { processed: true, jobId: job.id, state: "stale" }; }
          const id = randomUUID(); const ext = result.mimeType === "image/jpeg" ? "jpg" : result.mimeType === "image/png" ? "png" : "webp";
          const storageKey = `businesses/${job.businessId}/enhanced/${job.id}/${id}.${ext}`;
          await this.storage().put(storageKey, result.bytes, result.mimeType);
          if (!fresh()) { stale(); return { processed: true, jobId: job.id, state: "stale" }; }
          const asset = this.assets.createAsset({ id, businessId: job.businessId, storageKey, mimeType: result.mimeType as Asset["mimeType"], sizeBytes: result.bytes.byteLength, width: meta.width, height: meta.height });
          job = this.store.patchClaim(job.id, token, { enhancedAssetId: asset.id, enhancementStatus: "ready", enhancementModel: result.model, enhancementCompletedAt: this.now().toISOString() }, this.now());
        } catch { job = this.store.patchClaim(jobId, token, { enhancementStatus: "failed", enhancementCompletedAt: this.now().toISOString(), errorCode: "ENHANCEMENT_FAILED" }, this.now()); }
      }
      return { processed: true, jobId: job?.id, state: job ? "completed" : "lease_lost" };
    } catch {
      if (job) this.store.patchClaim(job.id, token, { analysisStatus: job.analysisStatus === "queued" ? "failed" : job.analysisStatus, enhancementStatus: job.enhancementStatus === "queued" ? "failed" : job.enhancementStatus, errorCode: "ORIGINAL_MEDIA_UNAVAILABLE" }, this.now());
      return { processed: true, jobId: job?.id, state: "failed" };
    } finally { if (job) this.store.release(job.id, token, this.now()); }
  }
}
