/** Public owner-facing media job projection. No price/stock inference belongs here. */
export type MediaStage = "queued" | "running" | "ready" | "failed" | "interrupted" | "stale";
export type MediaJobView = {
  id: string; productDraftId: string; originalAssetId: string; originalUrl: string;
  enhancedAssetId: string | null; enhancedUrl: string | null;
  sourceDraftRevision: number; currentDraftRevision: number;
  analysisStatus: MediaStage; enhancementStatus: MediaStage; selectedVariant: "original" | "enhanced";
  suggestedTitle: string | null; suggestedDescription: string | null;
  titleApplied: boolean; descriptionApplied: boolean; errorCode: string | null;
  evidence: { analysisModel: string | null; enhancementModel: string | null; analysisStartedAt: string | null; analysisCompletedAt: string | null; enhancementStartedAt: string | null; enhancementCompletedAt: string | null };
  createdAt: string; updatedAt: string;
};
export type MediaChoice = { jobId: string; expectedDraftRevision: number; applyTitle?: boolean; applyDescription?: boolean; useEnhanced?: boolean };

export function mediaJobMatchesDraft(job: MediaJobView, draft: { id: string; imageAssetId?: string | null }) {
  return job.productDraftId === draft.id && (draft.imageAssetId === job.originalAssetId || (job.selectedVariant === "enhanced" && !!job.enhancedAssetId && draft.imageAssetId === job.enhancedAssetId));
}
export function mediaJobIsRunning(job: MediaJobView) {
  return [job.analysisStatus, job.enhancementStatus].some(status => status === "queued" || status === "running");
}
export function mediaStageLabel(stage: MediaStage, kind: "analysis" | "enhancement") {
  if (stage === "queued") return kind === "analysis" ? "Queued for analysis" : "Queued for enhancement";
  if (stage === "running") return kind === "analysis" ? "Analyzing photo" : "Enhancing photo";
  if (stage === "ready") return kind === "analysis" ? "Suggestions ready" : "Enhanced photo ready";
  if (stage === "failed") return kind === "analysis" ? "Analysis failed" : "Enhancement failed";
  if (stage === "interrupted") return "Processing interrupted";
  return "Newer draft available";
}
export const ownerMediaAssetUrl = (assetId: string) => `/api/assets/${encodeURIComponent(assetId)}`;
