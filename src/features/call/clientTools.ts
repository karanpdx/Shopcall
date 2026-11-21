/** Agent tools use C's authenticated bridge. Owner confirmation secrets never return to the agent. */
import { z } from "zod";
import { clientToolSchemas, type ClientToolName } from "../../integrations/elevenlabs/tools";
import { flattenWorkingDraft, summarizeBatch, type ApiClient, type ProposalSummary, type WorkspaceDraft } from "./api";
import type { CatalogBatch } from "../../integrations/catalog-batches/types";
import type { DraftsAction, DraftsState } from "./drafts";

type Handler = (params: Record<string, unknown>) => Promise<string>;
export type ToolDeps = {
  api: ApiClient; callId: () => string | null; businessId: () => string | null; catalogRevision: () => number;
  drafts: () => DraftsState; dispatch: (action: DraftsAction) => void;
  captureForDraft: (draftId: string) => Promise<{ ok: true; captureId: string; thumbnailUrl: string } | { ok: false; error: string }>;
  isCameraOn: () => boolean;
  rememberProposal: (kind: "catalog_change" | "publish", proposal: ProposalSummary) => void;
  openConfirmation: (kind: "catalog_change" | "publish", proposalId: string) => boolean | Promise<boolean>;
  newIdempotencyKey: () => string;
  refreshWorkspace?: () => Promise<void>;
};
const failure = (code: string, message: string) => JSON.stringify({ ok: false, error: { code, message } });

export function createClientTools(deps: ToolDeps): Record<ClientToolName, Handler> {
  const handlers = {} as Record<ClientToolName, Handler>;
  for (const name of Object.keys(clientToolSchemas) as ClientToolName[]) {
    handlers[name] = async (params) => {
      const parsed = clientToolSchemas[name].safeParse(params ?? {});
      if (!parsed.success) return failure("INVALID_INPUT", "Provide the exact typed tool fields; prices and quantities must be nonnegative integers.");
      const callId = deps.callId();
      if (!callId) return failure("NOT_READY", "Start an authenticated call first.");
      if (name === "capture_product_photo") {
        const { productDraftId } = parsed.data as z.infer<typeof clientToolSchemas.capture_product_photo>;
        if (!deps.isCameraOn()) return failure("CAMERA_OFF", "Camera is off. Ask owner to turn it on or upload a photo; audio can continue.");
        if (!deps.drafts().byId[productDraftId]) return failure("NOT_FOUND", "Product draft is not in this call.");
      }
      const response = await deps.api.voiceTool(callId, name, parsed.data, deps.newIdempotencyKey());
      if (deps.callId() !== callId) return failure("CALL_CHANGED", "This call ended or the signed-in account changed. Discard the old tool result.");
      if (!response.ok) return JSON.stringify(response);
      const data = response.data;
      if (data.draft && typeof data.draft === "object") deps.dispatch({ type: "draft_saved", draft: flattenWorkingDraft(data.draft as WorkspaceDraft) });
      if (Array.isArray(data.drafts)) for (const draft of data.drafts as WorkspaceDraft[]) deps.dispatch({ type: "draft_saved", draft: flattenWorkingDraft(draft) });
      if (data.proposal && typeof data.proposal === "object") deps.rememberProposal("catalog_change", summarizeBatch(data.proposal as CatalogBatch));
      if (name === "capture_product_photo") {
        const draftId = (parsed.data as { productDraftId: string }).productDraftId;
        const capture = await deps.captureForDraft(draftId);
        if (deps.callId() !== callId) return failure("CALL_CHANGED", "This call is no longer current.");
        return capture.ok ? JSON.stringify({ ok: true, data: { ...capture, productDraftId: draftId, saved: true } }) : failure("CAPTURE_FAILED", capture.error);
      }
      if (name === "show_confirmation") {
        const args = parsed.data as z.infer<typeof clientToolSchemas.show_confirmation>;
        const kind = data.action === "show_publication_review" ? "publish" : args.kind;
        const proposalId = data.action === "show_publication_review" && typeof data.proposalId === "string" ? data.proposalId : args.proposalId;
        const opened = await deps.openConfirmation(kind, proposalId);
        return opened ? JSON.stringify({ ok: true, data: { opened: true, approved: false, applied: false } }) : failure("NOT_READY", "Owner review could not open. No changes were applied.");
      }
      if (name === "record_product_details") {
        const draft = data.draft as WorkspaceDraft | undefined;
        const id = (parsed.data as { productDraftId: string }).productDraftId;
        // One selected still when the owner has enabled the camera and supplied
        // this item's critical facts. Never wait for a second spoken photo yes.
        if (draft?.id === id && !draft.imageAssetId && deps.isCameraOn() && draft.fields?.title?.trim() && typeof draft.fields.priceMinor === "number" && typeof draft.fields.quantityOnHand === "number") {
          const capture = await deps.captureForDraft(id);
          if (deps.callId() !== callId) return failure("CALL_CHANGED", "This call is no longer current.");
          await deps.refreshWorkspace?.();
          return JSON.stringify({ ok: true, data: { ...data, autoCapture: capture.ok ? { ...capture, productDraftId: id, saved: true } : { saved: false, error: capture.error } } });
        }
      }
      await deps.refreshWorkspace?.();
      // Review tokens are issued by a separate owner UI route, never this bridge/tool response.
      return JSON.stringify({ ok: true, data });
    };
  }
  return handlers;
}
