/** Same-origin browser adapter for the implemented B catalog + C call workspace. */
import type { ApiResult, Business, Product, Session, BuildJob as BackendBuildJob, ProductChange } from "../../contracts/api";
import type { BuildJob } from "../../contracts/integrations";
import type { WorkingCall, WorkingProductDraft } from "../../integrations/call-workspace/store";
import type { CatalogBatch } from "../../integrations/catalog-batches/types";
import type { ClientToolName } from "../../integrations/elevenlabs/tools";

export type ApiError = Extract<ApiResult<never>, { ok: false }>["error"];
export type OwnerSession = Session & { business: Session["business"] & { contactEmail: string | null }; catalogRevision: number; latestJobId?: string | null };
export type VoiceCredential = { signedUrl: string; connectionType: "websocket"; callId: string };
export type DraftPatch = { title?: string; description?: string; priceMinor?: number; currencyCode?: string; quantityOnHand?: number | null; inventoryTracked?: boolean };
export type SavedDraft = DraftPatch & { id: string; imageAssetId?: string | null; imageUrl?: string | null; proposalId?: string | null; revision?: number; approved?: boolean };
export type WorkspaceDraft = WorkingProductDraft & { ready?: boolean; missing?: string[]; imageUrl?: string | null };
export type CallSnapshot = { call: WorkingCall; drafts: WorkspaceDraft[] };
export type UploadedCapture = { captureId: string; productDraftId: string; thumbnailUrl: string; draft?: WorkingProductDraft };
export type ProposalSummary = { id: string; expiresAt: string; approvalNonce: string; items: { label: string; before: string; after: string }[]; publishesInformation?: boolean; snapshotRevision?: number; batch?: CatalogBatch; omittedDraftCount?: number; catalogApplied?: boolean };
export type CombinedCallReview = { proposal: CatalogBatch | null; business: { name: string; contactEmail: string; description: string | null }; productDraftIds: string[]; incompleteDraftIds: string[]; noCatalogChanges?: boolean };
export type ProductMatch = { productId: string; title: string; imageUrl: string | null };
export type WorkflowTask = { id: string; role: string };
export type BackendBuildStatus = BackendBuildJob & { workflow?: { job: BuildJob | null; task: WorkflowTask | null; blocked: boolean; requiresReconciliation: boolean } };
export type UiBuildStatus = BuildJob & { backendStatus: Pick<BackendBuildJob, "buildStatus" | "publicationStatus">; requiresAttention: boolean; task: WorkflowTask | null };

const ownerAssetUrl = (assetId: string) => `/api/assets/${encodeURIComponent(assetId)}`;

export function flattenWorkingDraft(draft: WorkspaceDraft): SavedDraft {
  return { id: draft.id, ...draft.fields, imageAssetId: draft.imageAssetId, imageUrl: draft.imageAssetId ? ownerAssetUrl(draft.imageAssetId) : null, proposalId: draft.proposalId, revision: draft.revision };
}

export function summarizeBatch(batch: CatalogBatch, confirmationToken = ""): ProposalSummary {
  return {
    id: batch.id, expiresAt: batch.expiresAt, approvalNonce: confirmationToken, snapshotRevision: batch.expectedCatalogRevision, batch,
    publishesInformation: batch.changes.some(change => change.type === "create_product" || change.type === "update_storefront"),
    items: batch.summary.map((summary, index) => {
      const colon = summary.indexOf(": ");
      const label = colon >= 0 ? summary.slice(0, colon) : `Change ${index + 1}`;
      const detail = colon >= 0 ? summary.slice(colon + 2) : summary;
      const arrow = detail.indexOf(" → ");
      return { label, before: arrow >= 0 ? detail.slice(0, arrow) : "Not applied", after: arrow >= 0 ? detail.slice(arrow + 3) : detail };
    }),
  };
}

export function normalizeBuildJob(job: BackendBuildStatus): UiBuildStatus {
  const failed = job.buildStatus === "failed" || job.publicationStatus === "failed";
  const requiresAttention = job.workflow?.blocked === true || job.workflow?.requiresReconciliation === true;
  const phase = failed || requiresAttention ? "failed" : job.buildStatus === "queued" ? "queued" : job.buildStatus === "running" ? "building" : job.publicationStatus === "completed" && job.publicUrl ? "ready" : "verifying";
  return { id: job.id, businessId: job.businessId, phase, replId: job.providerJobId, publicUrl: phase === "ready" ? job.publicUrl : null, error: job.errorMessage ?? (requiresAttention ? job.workflow?.job?.error ?? "Build needs attention before it can continue. Your saved catalog remains available." : null), createdAt: job.createdAt, updatedAt: job.updatedAt,
    backendStatus: { buildStatus: job.buildStatus, publicationStatus: job.publicationStatus }, requiresAttention, task: job.workflow?.task ?? null };
}

function isResult(value: unknown): value is ApiResult<unknown> {
  if (!value || typeof value !== "object" || !("ok" in value)) return false;
  const result = value as { ok: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };
  return result.ok === true ? "data" in result : result.ok === false && typeof result.error?.code === "string" && typeof result.error?.message === "string";
}

export function createApiClient(fetcher: typeof fetch = (...args) => fetch(...args)) {
  async function request<T>(method: string, path: string, body?: unknown, extraHeaders?: HeadersInit): Promise<ApiResult<T>> {
    const headers = new Headers(extraHeaders); headers.set("accept", "application/json");
    const init: RequestInit = { method, credentials: "same-origin", cache: "no-store", headers };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { init.body = JSON.stringify(body); headers.set("content-type", "application/json"); }
    let response: Response;
    try { response = await fetcher(path, init); }
    catch { return { ok: false, error: { code: "PROVIDER_ERROR", message: "Couldn't reach Shopcall. Your saved details are safe; retry when connected." } }; }
    let result: unknown;
    try { result = await response.json(); } catch { /* Bad/missing server response is never success. */ }
    if (isResult(result) && (!result.ok || response.ok)) return result as ApiResult<T>;
    return { ok: false, error: { code: response.status === 404 || response.status === 405 ? "NOT_READY" : "PROVIDER_ERROR", message: `Unable to complete ${path} (${response.status}).` } };
  }
  const id = encodeURIComponent;
  const api = {
    login: (email: string, password: string) => request<Session>("POST", "/api/auth/login", { email, password }),
    logout: () => request<unknown>("POST", "/api/auth/logout", {}),
    async getSession(): Promise<ApiResult<OwnerSession>> {
      const session = await request<Session>("GET", "/api/session");
      if (!session.ok) return session;
      const business = await request<Business>("GET", "/api/business");
      if (!business.ok) return business;
      return { ok: true, data: { ...session.data, business: { ...session.data.business, name: business.data.name, contactEmail: business.data.contactEmail }, catalogRevision: business.data.catalogRevision } };
    },
    getBusiness: () => request<Business>("GET", "/api/business"),
    getProducts: () => request<Product[]>("GET", "/api/products"),
    createCall: (mode: "create" | "update", idempotencyKey: string) => request<CallSnapshot>("POST", "/api/calls", { mode, idempotencyKey }),
    getCall: (callId: string) => request<CallSnapshot>("GET", `/api/calls/${id(callId)}`),
    endCall: (callId: string) => request<WorkingCall>("POST", `/api/calls/${id(callId)}/end`, {}),
    createVoiceSession: (callId: string) => request<VoiceCredential>("POST", "/api/voice/session", { callId }),
    voiceTool: (callId: string, name: ClientToolName, args: unknown, idempotencyKey: string) => request<Record<string, unknown>>("POST", "/api/voice/tools", { callId, name, arguments: args, idempotencyKey }),
    async createDraft(callId: string, idempotencyKey: string, title?: string): Promise<ApiResult<SavedDraft>> {
      const response = await request<WorkspaceDraft>("POST", `/api/calls/${id(callId)}/drafts`, { idempotencyKey, ...(title ? { proposedTitle: title } : {}) });
      return response.ok ? { ok: true, data: flattenWorkingDraft(response.data) } : response;
    },
    async patchDraft(callId: string, draftId: string, patch: DraftPatch): Promise<ApiResult<SavedDraft>> {
      const response = await request<{ draft: WorkspaceDraft }>("PATCH", `/api/calls/${id(callId)}/drafts/${id(draftId)}`, patch);
      return response.ok ? { ok: true, data: flattenWorkingDraft(response.data.draft) } : response;
    },
    async uploadDraftImage(callId: string, draftId: string, image: Blob, capturedAt: string): Promise<ApiResult<UploadedCapture>> {
      const form = new FormData(); form.set("file", image, image.type === "image/png" ? "capture.png" : image.type === "image/webp" ? "capture.webp" : "capture.jpg");
      const response = await request<UploadedCapture>("POST", `/api/calls/${id(callId)}/drafts/${id(draftId)}/images`, form, { "x-captured-at": capturedAt });
      return response.ok ? { ok: true, data: { ...response.data, thumbnailUrl: ownerAssetUrl(response.data.captureId) } } : response;
    },
    proposeProduct: (callId: string, draftId: string) => request<{ proposal: CatalogBatch }>("POST", `/api/calls/${id(callId)}/drafts/${id(draftId)}/proposal`, {}),
    proposeCallReview: (callId: string, input: { name: string; contactEmail: string; idempotencyKey: string }) => request<CombinedCallReview>("POST", `/api/calls/${id(callId)}/review`, input),
    proposeCatalogChanges: (input: { callId: string; expectedCatalogRevision: number; idempotencyKey: string; changes: ProductChange[] }) => request<CatalogBatch>("POST", "/api/catalog/proposals", input),
    getCatalogProposal: (proposalId: string) => request<CatalogBatch>("GET", `/api/catalog/proposals/${id(proposalId)}`),
    async reviewCatalogProposal(proposalId: string): Promise<ApiResult<ProposalSummary>> {
      const response = await request<{ batch: CatalogBatch; confirmationToken: string }>("POST", `/api/catalog/proposals/${id(proposalId)}/review`, {});
      return response.ok ? { ok: true, data: summarizeBatch(response.data.batch, response.data.confirmationToken) } : response;
    },
    confirmCatalogProposal: (proposalId: string, confirmationToken: string, idempotencyKey: string) => request<CatalogBatch>("POST", `/api/catalog/proposals/${id(proposalId)}/confirm`, { confirmationToken, idempotencyKey }),
    rejectCatalogProposal: (proposalId: string) => request<CatalogBatch>("POST", `/api/catalog/proposals/${id(proposalId)}/reject`, {}),
    async createBuild(designBrief: string, expectedCatalogRevision: number): Promise<ApiResult<BuildJob>> {
      const response = await request<BackendBuildJob>("POST", "/api/builds", { designBrief, expectedCatalogRevision });
      return response.ok ? { ok: true, data: normalizeBuildJob(response.data) } : response;
    },
    async getJob(jobId: string): Promise<ApiResult<UiBuildStatus>> {
      const response = await request<BackendBuildStatus>("GET", `/api/builds/${id(jobId)}`);
      return response.ok ? { ok: true, data: normalizeBuildJob(response.data) } : response;
    },
  };
  return api;
}
export type ApiClient = ReturnType<typeof createApiClient>;
