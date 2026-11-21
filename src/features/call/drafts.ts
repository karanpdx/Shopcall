/**
 * Product draft tray state. Pure reducer so ID binding is testable.
 *
 * Invariant: a capture is attached to the draft ID recorded when the capture
 * *started*, never to whichever draft is active when the upload settles.
 */
import type { DraftPatch, SavedDraft, UploadedCapture } from "./api";

export type CaptureView = {
  localId: string;
  previewUrl: string;
  status: "uploading" | "saved" | "failed";
  captureId?: string;
  thumbnailUrl?: string;
  error?: string;
};

export type DraftView = Required<Pick<DraftPatch, "title" | "description" | "currencyCode">> & {
  id: string;
  priceMinor: number | null;
  quantityOnHand: number | null;
  inventoryTracked: boolean | null;
  captures: CaptureView[];
  imageAssetId?: string | null;
  proposalId?: string | null;
  approved?: boolean;
  revision?: number;
};

export type DraftsState = { order: string[]; byId: Record<string, DraftView>; activeId: string | null };

export type DraftsAction =
  | { type: "reset" }
  | { type: "draft_saved"; draft: SavedDraft }
  | { type: "set_active"; draftId: string }
  | { type: "capture_started"; draftId: string; localId: string; previewUrl: string }
  | { type: "capture_settled"; draftId: string; localId: string; result: { ok: true; data: UploadedCapture } | { ok: false; message: string } }
  | { type: "capture_removed"; draftId: string; localId: string };

export const initialDrafts: DraftsState = { order: [], byId: {}, activeId: null };

function blankDraft(id: string): DraftView {
  return { id, title: "", description: "", currencyCode: "USD", priceMinor: null, quantityOnHand: null, inventoryTracked: null, captures: [] };
}

function updateCapture(state: DraftsState, draftId: string, localId: string, fn: (c: CaptureView) => CaptureView | null): DraftsState {
  const draft = state.byId[draftId];
  if (!draft) return state;
  const captures = draft.captures.flatMap(c => (c.localId === localId ? [fn(c)].filter((x): x is CaptureView => x !== null) : [c]));
  return { ...state, byId: { ...state.byId, [draftId]: { ...draft, captures } } };
}

export function draftsReducer(state: DraftsState, action: DraftsAction): DraftsState {
  switch (action.type) {
    case "reset": return initialDrafts;
    case "draft_saved": {
      const { id, ...fields } = action.draft;
      const existing = state.byId[id] ?? blankDraft(id);
      const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      const next = { ...existing, ...defined };
      if (action.draft.imageUrl && action.draft.imageAssetId && !next.captures.some(c => c.captureId === action.draft.imageAssetId)) {
        next.captures = [{ localId: `saved-${action.draft.imageAssetId}`, previewUrl: action.draft.imageUrl, thumbnailUrl: action.draft.imageUrl, captureId: action.draft.imageAssetId, status: "saved" }];
      }
      const isNew = !state.byId[id];
      return {
        order: isNew ? [...state.order, id] : state.order,
        byId: { ...state.byId, [id]: next },
        activeId: isNew ? id : state.activeId,
      };
    }
    case "set_active":
      return state.byId[action.draftId] ? { ...state, activeId: action.draftId } : state;
    case "capture_started": {
      const draft = state.byId[action.draftId];
      if (!draft) return state;
      const capture: CaptureView = { localId: action.localId, previewUrl: action.previewUrl, status: "uploading" };
      return { ...state, byId: { ...state.byId, [draft.id]: { ...draft, captures: [...draft.captures, capture] } } };
    }
    case "capture_settled": {
      const { result } = action;
      if (result.ok && result.data.productDraftId !== action.draftId) {
        return updateCapture(state, action.draftId, action.localId, c => ({
          ...c, status: "failed", error: "The server attached this photo to a different product. Not saved here.",
        }));
      }
      return updateCapture(state, action.draftId, action.localId, c =>
        result.ok
          ? { ...c, status: "saved", captureId: result.data.captureId, thumbnailUrl: result.data.thumbnailUrl, error: undefined }
          : { ...c, status: "failed", error: result.message },
      );
    }
    case "capture_removed":
      return updateCapture(state, action.draftId, action.localId, () => null);
  }
}

export type MissingField = "name" | "price" | "stock" | "photo";

export function missingFields(d: DraftView): MissingField[] {
  const missing: MissingField[] = [];
  if (!d.title.trim()) missing.push("name");
  if (d.priceMinor === null) missing.push("price");
  if (d.inventoryTracked === null || (d.inventoryTracked && d.quantityOnHand === null)) missing.push("stock");
  if (!d.captures.some(c => c.status === "saved")) missing.push("photo");
  return missing;
}

/** "$24.00" / "24" / "24.5" → 2400 / 2400 / 2450; null when not a valid nonnegative amount. */
export function parsePriceToMinor(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

export function formatMoney(minor: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currencyCode }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currencyCode}`;
  }
}
