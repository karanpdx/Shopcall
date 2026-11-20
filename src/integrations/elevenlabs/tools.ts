import { z } from "zod";
import type { ElevenLabs } from "@elevenlabs/elevenlabs-js";
import { catalogChange, currency, moneyMinor, quantity } from "../../contracts/catalog";

// Browser handlers validate again, then backend independently authenticates and validates.
// IDs identifying the current owner/business/call come from the session, not these tools.
export const clientToolSchemas = {
  upsert_business_brief: z.object({
    name: z.string().min(1).max(160).optional(), description: z.string().max(4000).optional(),
    style: z.string().max(2000).optional(), contactEmail: z.email().optional(),
  }).strict(),
  create_product_draft: z.object({ proposedTitle: z.string().max(160).optional() }).strict(),
  record_product_details: z.object({
    productDraftId: z.uuid(), title: z.string().min(1).max(160).optional(),
    description: z.string().max(4000).optional(), priceMinor: moneyMinor.optional(),
    currencyCode: currency.optional(), quantityOnHand: quantity.optional(), inventoryTracked: z.boolean().optional(),
  }).strict(),
  capture_product_photo: z.object({ productDraftId: z.uuid() }).strict(),
  get_catalog_summary: z.object({}).strict(),
  resolve_product_reference: z.object({ phrase: z.string().min(1).max(300) }).strict(),
  preview_catalog_changes: z.object({ changes: z.array(catalogChange).min(1).max(50) }).strict(),
  show_confirmation: z.object({ kind: z.enum(["publish", "catalog_change"]), proposalId: z.uuid() }).strict(),
  get_build_status: z.object({ buildJobId: z.uuid() }).strict(),
} as const;

export type ClientToolName = keyof typeof clientToolSchemas;
export type ClientToolArgs<N extends ClientToolName> = z.infer<(typeof clientToolSchemas)[N]>;
export function parseClientToolArgs<N extends ClientToolName>(name: N, args: unknown): ClientToolArgs<N> {
  return clientToolSchemas[name].parse(args) as ClientToolArgs<N>;
}

type Property = ElevenLabs.ObjectJsonSchemaPropertyOutputPropertiesValue;
const str = (description: string): Property => ({ type: "string", description });
const num = (description: string): Property => ({ type: "integer", description });
const obj = (properties: Record<string, Property>, required: string[] = []): ElevenLabs.ObjectJsonSchemaPropertyOutput => ({ type: "object", properties, required });
const definitions: Record<ClientToolName, { description: string; parameters: ElevenLabs.ObjectJsonSchemaPropertyOutput }> = {
  upsert_business_brief: {
    description: "Save owner-stated business details as a draft. Never publish; owner must review contact details before public use.",
    parameters: obj({ name: str("Owner's business name"), description: str("Owner's business story"), style: str("Owner's preferred visual style"), contactEmail: str("Owner-approved contact email, not an inferred address") }),
  },
  create_product_draft: { description: "Create one product draft; returns stable productDraftId. Reuse that ID for details and captures. Never create duplicates to correct a name.", parameters: obj({ proposedTitle: str("Proposed title, if owner supplied one") }) },
  record_product_details: {
    description: "Update the identified draft with owner-stated fields. Price is integer minor units; never infer price/stock from photos. Does not publish or establish approval.",
    parameters: obj({ productDraftId: str("Existing product draft UUID"), title: str("Owner's product name"), description: str("Owner's product description"), priceMinor: num("Exact owner-stated price in minor units, e.g. $24 = 2400"), currencyCode: str("Three-letter currency, e.g. USD"), quantityOnHand: num("Owner-stated nonnegative available count"), inventoryTracked: { type: "boolean", description: "Whether owner explicitly wants inventory tracking; false means intentionally untracked" } }, ["productDraftId"]),
  },
  capture_product_photo: { description: "Ask browser to capture/upload one still for this draft. Camera must be enabled; on denial offer upload. Success only after backend confirms capture ID.", parameters: obj({ productDraftId: str("Draft UUID to attach photo to, even if conversation moves on") }, ["productDraftId"]) },
  get_catalog_summary: { description: "Get current authenticated owner's canonical catalog and revisions. Call at start of every returning conversation; never rely on previous transcript for stock.", parameters: obj({}) },
  resolve_product_reference: { description: "Find canonical product IDs matching owner's words. Multiple matches require clarification. Do not choose arbitrary product.", parameters: obj({ phrase: str("Owner's product reference") }, ["phrase"]) },
  preview_catalog_changes: {
    description: "Preview atomic changes for resolved canonical product UUIDs. Does not apply. Sold out = set_quantity 0; sold one = adjust_quantity -1. Ambiguous sold it requires clarification first.",
    parameters: obj({ changes: { type: "array", description: "Proposed edits, no approval flag", items: obj({
      type: { type: "string", enum: ["set_price", "set_quantity", "adjust_quantity", "set_status"], description: "Change operation" },
      productId: str("Canonical product UUID returned by catalog lookup"), newPriceMinor: num("Required only for set_price"), currencyCode: str("Required only for set_price"),
      newQuantity: num("Required only for set_quantity"), delta: num("Required only for adjust_quantity"), status: { type: "string", enum: ["active", "archived"], description: "Required only for set_status" },
    }, ["type", "productId"]) } }, ["changes"]),
  },
  show_confirmation: { description: "Open owner review panel for an existing proposal. Cannot approve, apply, or publish. Ask owner to review and click confirmation; do not claim success until backend result.", parameters: obj({ kind: { type: "string", enum: ["publish", "catalog_change"], description: "Review panel type" }, proposalId: str("Existing proposal UUID returned by backend") }, ["kind", "proposalId"]) },
  get_build_status: { description: "Read actual publication job state. Only ready with verified public URL means published. Failure/pending must be explained honestly.", parameters: obj({ buildJobId: str("Existing publication job UUID") }, ["buildJobId"]) },
};

export const shopcallClientTools: ElevenLabs.PromptAgentApiModelOutputToolsItem.Client[] =
  Object.entries(definitions).map(([name, definition]) => ({ type: "client", name, ...definition, expectsResponse: true, responseTimeoutSecs: name === "capture_product_photo" ? 90 : 30, toolErrorHandlingMode: "summarized" }));
