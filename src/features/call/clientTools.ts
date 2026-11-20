/**
 * Handlers for the agent's client tools (CLIENT_TOOL_NAMES in src/contracts).
 *
 * - Data tools forward to B's authenticated routes and report success only
 *   after the backend responds ok.
 * - The call ID and business ID come from this browser session, never from
 *   the agent's arguments.
 * - show_confirmation only opens the review panel. It never approves anything.
 *
 * Parameter names are camelCase per docs/api-contract.md. C owns the agent's
 * tool schemas; keep these parsers in sync with them.
 */
import { z } from "zod";
import { catalogChange } from "../../contracts/catalog";
import type { CLIENT_TOOL_NAMES } from "../../contracts/integrations";
import type { ApiClient, ApiError, ProposalSummary } from "./api";
import type { DraftsAction, DraftsState } from "./drafts";

type ToolName = (typeof CLIENT_TOOL_NAMES)[number];
type Handler = (params: Record<string, unknown>) => Promise<string>;

export type ToolDeps = {
  api: ApiClient;
  callId: () => string | null;
  businessId: () => string | null;
  catalogRevision: () => number;
  drafts: () => DraftsState;
  dispatch: (action: DraftsAction) => void;
  /** Captures a still and uploads it to the given draft. Rejects if camera is off. */
  captureForDraft: (draftId: string) => Promise<{ ok: true; captureId: string; thumbnailUrl: string } | { ok: false; error: string }>;
  isCameraOn: () => boolean;
  rememberProposal: (kind: "catalog_change" | "publish", proposal: ProposalSummary) => void;
  openConfirmation: (kind: "catalog_change" | "publish", proposalId: string) => boolean;
  newIdempotencyKey: () => string;
};

const ok = (data: unknown) => JSON.stringify({ ok: true, data });
const fail = (code: string, message: string) => JSON.stringify({ ok: false, error: { code, message } });
const fromApi = (e: ApiError) => fail(e.code, e.message);

const uuid = z.uuid();
const schemas = {
  upsert_business_brief: z.object({ changes: z.record(z.string(), z.unknown()) }),
  create_product_draft: z.object({ proposedTitle: z.string().max(160).optional() }),
  record_product_details: z.object({
    productDraftId: uuid,
    fields: z.object({
      title: z.string().trim().min(1).max(160).optional(),
      description: z.string().max(4000).optional(),
      priceMinor: z.number().int().nonnegative().optional(),
      currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(),
      quantityOnHand: z.number().int().nonnegative().nullable().optional(),
      inventoryTracked: z.boolean().optional(),
    }).strict(),
  }),
  capture_product_photo: z.object({ productDraftId: uuid, view: z.string().optional(), reason: z.string().optional() }),
  get_catalog_summary: z.object({}).passthrough(),
  resolve_product_reference: z.object({ phrase: z.string().trim().min(1).max(200) }),
  preview_catalog_changes: z.object({ changes: z.array(catalogChange).min(1).max(50) }),
  show_confirmation: z.object({ kind: z.enum(["publish", "catalog_change"]), proposalId: z.string().min(1) }),
  get_build_status: z.object({ buildJobId: uuid }),
} satisfies Record<ToolName, z.ZodType>;

export function createClientTools(deps: ToolDeps): Record<ToolName, Handler> {
  function parse<N extends ToolName>(name: N, params: unknown) {
    return schemas[name].safeParse(params ?? {}) as z.ZodSafeParseResult<z.infer<(typeof schemas)[N]>>;
  }
  const requireCall = () => deps.callId();
  const invalid = (msg: string) => fail("INVALID_INPUT", msg);

  return {
    async upsert_business_brief(params) {
      const p = parse("upsert_business_brief", params);
      if (!p.success) return invalid("changes must be an object of brief fields.");
      const res = await deps.api.patchBusiness(p.data.changes);
      return res.ok ? ok(res.data) : fromApi(res.error);
    },

    async create_product_draft(params) {
      const p = parse("create_product_draft", params);
      if (!p.success) return invalid("proposedTitle must be a short string.");
      const callId = requireCall();
      if (!callId) return fail("NOT_READY", "No active call.");
      const res = await deps.api.createDraft(callId, deps.newIdempotencyKey(), p.data.proposedTitle);
      if (!res.ok) return fromApi(res.error);
      deps.dispatch({ type: "draft_saved", draft: res.data });
      return ok({ productDraftId: res.data.id });
    },

    async record_product_details(params) {
      const p = parse("record_product_details", params);
      if (!p.success) return invalid("Provide productDraftId and valid fields (integer minor-unit price, nonnegative quantity).");
      if (!deps.drafts().byId[p.data.productDraftId]) return fail("NOT_FOUND", "That product draft isn't in this call.");
      const res = await deps.api.patchDraft(p.data.productDraftId, p.data.fields);
      if (!res.ok) return fromApi(res.error);
      deps.dispatch({ type: "draft_saved", draft: res.data });
      return ok(res.data);
    },

    async capture_product_photo(params) {
      const p = parse("capture_product_photo", params);
      if (!p.success) return invalid("Provide the productDraftId to attach the photo to.");
      if (!deps.isCameraOn()) return fail("CAMERA_OFF", "The owner's camera is off. Ask them to turn it on or upload a photo.");
      if (!deps.drafts().byId[p.data.productDraftId]) return fail("NOT_FOUND", "That product draft isn't in this call.");
      const res = await deps.captureForDraft(p.data.productDraftId);
      return res.ok ? ok({ captureId: res.captureId, productDraftId: p.data.productDraftId, thumbnailUrl: res.thumbnailUrl }) : fail("CAPTURE_FAILED", res.error);
    },

    async get_catalog_summary() {
      const res = await deps.api.getSession();
      return res.ok ? ok(res.data) : fromApi(res.error);
    },

    async resolve_product_reference(params) {
      const p = parse("resolve_product_reference", params);
      if (!p.success) return invalid("Provide the phrase the owner used.");
      const res = await deps.api.resolveProduct(p.data.phrase);
      if (!res.ok) return fromApi(res.error);
      const { matches } = res.data;
      return ok({ matches, needsClarification: matches.length !== 1 });
    },

    async preview_catalog_changes(params) {
      const p = parse("preview_catalog_changes", params);
      if (!p.success) return invalid("changes must be catalog changes with product UUIDs.");
      const callId = requireCall();
      const businessId = deps.businessId();
      if (!callId || !businessId) return fail("NOT_READY", "No active call or business.");
      const res = await deps.api.proposeCatalogChanges({
        businessId, callId, expectedCatalogRevision: deps.catalogRevision(),
        idempotencyKey: deps.newIdempotencyKey(), changes: p.data.changes,
      });
      if (!res.ok) return fromApi(res.error);
      deps.rememberProposal("catalog_change", res.data);
      // The nonce stays in the browser; the agent never sees it.
      return ok({ proposalId: res.data.id, items: res.data.items, expiresAt: res.data.expiresAt });
    },

    async show_confirmation(params) {
      const p = parse("show_confirmation", params);
      if (!p.success) return invalid("Provide kind and proposalId.");
      if (!deps.openConfirmation(p.data.kind, p.data.proposalId)) return fail("NOT_FOUND", "No proposal with that ID in this call.");
      return ok({ opened: true, approved: false, note: "Waiting for the owner to tap Confirm. Nothing is applied yet." });
    },

    async get_build_status(params) {
      const p = parse("get_build_status", params);
      if (!p.success) return invalid("Provide buildJobId.");
      const res = await deps.api.getJob(p.data.buildJobId);
      return res.ok ? ok(res.data) : fromApi(res.error);
    },
  };
}
