/**
 * Browser client for Person B's planned routes (docs/api-contract.md).
 *
 * Every call goes to the same origin with the session cookie. Nothing here
 * holds a provider secret. Routes that do not exist yet surface as NOT_READY
 * errors so the UI never shows a fabricated success state.
 */
import type { ApiResult, ProposedChanges } from "../../contracts/catalog";
import type { BuildJob } from "../../contracts/integrations";

export type ApiError = Extract<ApiResult<never>, { ok: false }>["error"];
type Fetcher = typeof fetch;

/** UI-side expectation of B's routes. Shapes marked "proposed" need B's sign-off. */
export type OwnerSession = {
  business: { id: string; name: string; contactEmail: string | null } | null;
  catalogRevision: number;
  /** proposed: lets a returning owner land on the latest job status */
  latestJobId?: string | null;
};
/** proposed: whichever credential C's adapter issues */
export type VoiceCredential = { conversationToken: string } | { signedUrl: string };
export type DraftPatch = {
  title?: string;
  description?: string;
  priceMinor?: number | null;
  currencyCode?: string;
  quantityOnHand?: number | null;
  inventoryTracked?: boolean;
};
export type SavedDraft = DraftPatch & { id: string };
export type UploadedCapture = { captureId: string; productDraftId: string; thumbnailUrl: string };
/** proposed: immutable before/after summary returned by B for owner review */
export type ProposalSummary = {
  id: string;
  expiresAt: string;
  approvalNonce: string;
  items: { label: string; before: string; after: string }[];
};
export type ProductMatch = { productId: string; title: string; imageUrl: string | null };

function notReady(path: string): ApiError {
  return { code: "NOT_READY", message: `${path} isn't available yet.` };
}

function isApiResult(value: unknown): value is ApiResult<unknown> {
  if (!value || typeof value !== "object" || !("ok" in value)) return false;
  const v = value as { ok: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };
  if (v.ok === true) return "data" in v;
  return v.ok === false && typeof v.error?.code === "string" && typeof v.error?.message === "string";
}

export function createApiClient(fetcher: Fetcher = (...args) => fetch(...args)) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const init: RequestInit = { method, credentials: "same-origin", headers: { accept: "application/json" } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { ...init.headers, "content-type": "application/json" };
    }
    let res: Response;
    try {
      res = await fetcher(path, init);
    } catch {
      return { ok: false, error: { code: "PROVIDER_ERROR", message: "Couldn't reach Shopcall. Check your connection." } };
    }
    if (res.status === 404 || res.status === 405) return { ok: false, error: notReady(path) };
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    if (isApiResult(json)) return json as ApiResult<T>;
    return { ok: false, error: { code: "PROVIDER_ERROR", message: `Unexpected response from ${path} (${res.status}).` } };
  }

  const id = (value: string) => encodeURIComponent(value);

  return {
    login: (email: string, password: string) => request<{ ok: true }>("POST", "/api/auth/login", { email, password }),
    logout: () => request<{ ok: true }>("POST", "/api/auth/logout", {}),
    getSession: () => request<OwnerSession>("GET", "/api/session"),
    createCall: (mode: "create" | "update") => request<{ callId: string }>("POST", "/api/calls", { mode }),
    endCall: (callId: string) => request<unknown>("POST", `/api/calls/${id(callId)}/end`, {}),
    createVoiceSession: (callId: string) => request<VoiceCredential>("POST", "/api/voice/session", { callId }),
    patchBusiness: (patch: Record<string, unknown>) => request<unknown>("PATCH", "/api/business", patch),
    createDraft: (callId: string, idempotencyKey: string, title?: string) =>
      request<SavedDraft>("POST", "/api/drafts", { callId, idempotencyKey, ...(title ? { title } : {}) }),
    patchDraft: (draftId: string, patch: DraftPatch) => request<SavedDraft>("PATCH", `/api/drafts/${id(draftId)}`, patch),
    uploadDraftImage: (draftId: string, image: Blob, capturedAt: string) => {
      const form = new FormData();
      form.set("image", image, "capture.jpg");
      form.set("capturedAt", capturedAt);
      return request<UploadedCapture>("POST", `/api/drafts/${id(draftId)}/images`, form);
    },
    resolveProduct: (phrase: string) => request<{ matches: ProductMatch[] }>("POST", "/api/catalog/resolve", { phrase }),
    proposeCatalogChanges: (changes: ProposedChanges) => request<ProposalSummary>("POST", "/api/catalog/proposals", changes),
    confirmCatalogProposal: (proposalId: string, approvalNonce: string, idempotencyKey: string) =>
      request<{ catalogRevision: number }>("POST", `/api/catalog/proposals/${id(proposalId)}/confirm`, { approvalNonce, idempotencyKey }),
    proposePublication: () => request<ProposalSummary>("POST", "/api/publication/proposals", {}),
    confirmPublication: (proposalId: string, approvalNonce: string, idempotencyKey: string) =>
      request<BuildJob>("POST", `/api/publication/proposals/${id(proposalId)}/confirm`, { approvalNonce, idempotencyKey }),
    getJob: (jobId: string) => request<BuildJob>("GET", `/api/jobs/${id(jobId)}`),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
