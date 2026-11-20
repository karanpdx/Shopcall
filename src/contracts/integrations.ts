export type BuildPhase = "queued" | "preparing" | "creating" | "building" | "publishing" | "verifying" | "ready" | "failed";

export type BuildJob = {
  id: string;
  businessId: string;
  phase: BuildPhase;
  replId: string | null;
  publicUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Implemented by catalog owner; consumed by integrations owner. */
export interface PublicationRepository {
  getApprovedSnapshot(businessId: string, approvalId: string): Promise<{
    businessName: string;
    catalogRevision: number;
    publicCatalogUrl: string;
    approvedDesignBrief: string;
  }>;
  updateJob(id: string, patch: Partial<Pick<BuildJob, "phase" | "replId" | "publicUrl" | "error">>): Promise<void>;
}

/** Camera operations run in browser; authenticated writes run in backend. */
export type CaptureResult = { ok: true; captureId: string; productDraftId: string; thumbnailUrl: string } | { ok: false; error: string };

export const CLIENT_TOOL_NAMES = [
  "upsert_business_brief", "create_product_draft", "record_product_details",
  "capture_product_photo", "get_catalog_summary", "resolve_product_reference",
  "preview_catalog_changes", "show_confirmation", "get_build_status",
] as const;

// No agent-callable apply/publish tool: owner UI approval authorizes backend commit.
