import type { Asset, Business, Product, ProductChange } from "../../contracts/api";
import { productCreateInput } from "../../contracts/api";
import { parseClientToolArgs, type ClientToolName } from "../elevenlabs/tools";
import { fail, HttpError } from "../../server/http";
import { assetUrl } from "../../server/config";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CallWorkspaceStore, type WorkspaceOwner, type WorkingProductDraft, type DraftFields, type CallReviewSnapshot } from "./store";

export type CatalogBatchPreview = { id: string; businessId: string; callId: string; status: "pending" | "approved" | "rejected"; changes: ProductChange[]; summary: string[] | string; expiresAt: string };
export interface WorkspaceCatalogRepository {
  getBusiness(businessId: string): Promise<Business | null>;
  listProducts(businessId: string): Promise<Product[]>;
  getProduct(businessId: string, productId: string): Promise<Product | null>;
  proposeCatalogBatch(businessId: string, input: { callId: string; expectedCatalogRevision: number; idempotencyKey: string; changes: ProductChange[] }): Promise<CatalogBatchPreview>;
  getCatalogBatch(businessId: string, proposalId: string): CatalogBatchPreview | null | Promise<CatalogBatchPreview | null>;
  rejectCatalogBatch(businessId: string, proposalId: string): Promise<CatalogBatchPreview>;
  getBuildJob(businessId: string, jobId: string): Promise<unknown | null>;
}

export function draftReadiness(draft: WorkingProductDraft) {
  const missing = [!draft.fields.title && "title", draft.fields.priceMinor === undefined && "priceMinor", draft.fields.quantityOnHand === undefined && "quantityOnHand", !draft.imageAssetId && "imageAssetId"].filter(Boolean) as string[];
  return { ready: missing.length === 0, missing };
}

export class CallWorkspaceService {
  constructor(readonly store: CallWorkspaceStore, private readonly catalog: WorkspaceCatalogRepository) {}

  async current(owner: WorkspaceOwner, callId: string) {
    return { call: this.store.getCall(owner, callId), drafts: this.store.listDrafts(owner, callId).map(draft => ({ ...draft, ...draftReadiness(draft), imageUrl: draft.imageAssetId ? assetUrl(draft.imageAssetId) : null })) };
  }

  async editable(owner: WorkspaceOwner, callId: string, draftId: string) {
    const draft = this.store.getDraft(owner, callId, draftId);
    if (draft.proposalId) {
      const existing = await this.catalog.getCatalogBatch(owner.businessId, draft.proposalId);
      if (existing?.status !== "rejected") fail(409, "CONFLICT", "Review or reject the existing proposal before changing this product draft.");
      this.store.clearRejectedProposal(owner, callId, draftId, draft.proposalId);
    }
  }

  async updateDraft(owner: WorkspaceOwner, callId: string, draftId: string, input: DraftFields) {
    await this.editable(owner, callId, draftId);
    const draft = this.store.patchDraft(owner, callId, draftId, input);
    return { draft, ...draftReadiness(draft), saved: true, published: false };
  }

  async attachImage(owner: WorkspaceOwner, callId: string, draftId: string, asset: Pick<Asset, "id" | "businessId" | "url">, capturedAt: string) {
    if (asset.businessId !== owner.businessId) fail(404, "NOT_FOUND", "Image asset not found for this business.");
    await this.editable(owner, callId, draftId);
    const draft = this.store.attachImage(owner, callId, draftId, asset.id, capturedAt);
    return { captureId: asset.id, productDraftId: draftId, thumbnailUrl: asset.url, draft, ...draftReadiness(draft), saved: true, published: false };
  }

  async proposeProduct(owner: WorkspaceOwner, callId: string, draftId: string) {
    const draft = this.store.getDraft(owner, callId, draftId);
    if (draft.proposalId && draft.proposalRevision === draft.revision) {
      const existing = await this.catalog.getCatalogBatch(owner.businessId, draft.proposalId);
      if (existing) return existing;
      fail(409, "CONFLICT", "The existing proposal is unavailable. Refresh before retrying.");
    }
    const readiness = draftReadiness(draft);
    if (!readiness.ready) fail(409, "NOT_READY", `Complete product details before review: ${readiness.missing.join(", ")}.`);
    const business = await this.catalog.getBusiness(owner.businessId);
    if (!business) return fail(404, "NOT_FOUND", "Business not found.");
    const product = productCreateInput.parse({ name: draft.fields.title, description: draft.fields.description, priceCents: draft.fields.priceMinor, inventoryCount: draft.fields.quantityOnHand, imageAssetId: draft.imageAssetId });
    const frozen = this.store.reserveProposal(owner, callId, draftId, draft.revision, business.catalogRevision);
    let proposal: CatalogBatchPreview;
    try {
      proposal = await this.catalog.proposeCatalogBatch(owner.businessId, { callId, expectedCatalogRevision: frozen.proposalCatalogRevision!, idempotencyKey: `call-draft/${draft.id}/${draft.revision}`, changes: [{ type: "create_product", product }] });
    } catch (error) {
      // Definite repository rejections commit no proposal. Unknown outcomes remain
      // frozen and retry with identical payload/key/catalog revision after restart.
      if (error instanceof HttpError && error.status >= 400 && error.status < 500) this.store.releaseRejectedReservation(owner, callId, draftId, draft.revision);
      throw error;
    }
    this.store.linkProposal(owner, callId, draftId, draft.revision, proposal.id);
    return proposal;
  }

  /** Owner UI preparation only. One exact batch; applying still requires explicit owner confirmation. */
  async prepareCallReview(owner: WorkspaceOwner, callId: string, raw: unknown) {
    const input = z.object({ name: z.string().trim().min(1).max(160), contactEmail: z.email(), idempotencyKey: z.string().min(1).max(160) }).strict().parse(raw);
    const call = this.store.getCall(owner, callId); // Ended calls remain reviewable; no audio restart.
    const requestHash = createHash("sha256").update(JSON.stringify({ name: input.name, contactEmail: input.contactEmail })).digest("hex");
    const existing = this.store.getCombinedReview(owner, callId, input.idempotencyKey) ?? this.store.getUnlinkedCombinedReview(owner, callId);
    if (existing) {
      if (existing.requestHash !== requestHash) fail(409, "CONFLICT", "An earlier review has different frozen business details. Recover or reject that review before preparing another.");
      return this.finishCombinedReview(owner, callId, existing);
    }
    let drafts = this.store.listDrafts(owner, callId);
    const approvedIds = new Set<string>(); const pendingIds = new Set<string>();
    for (const draft of drafts) {
      if (draft.proposalId) {
        const batch = await this.catalog.getCatalogBatch(owner.businessId, draft.proposalId);
        if (!batch) return fail(409, "NOT_READY", "A product review could not be reconciled. Reload its existing proposal.");
        if (batch.status === "approved") approvedIds.add(draft.id);
        else if (batch.status === "pending") pendingIds.add(batch.id);
      } else if (draft.proposalRevision !== null) return fail(409, "NOT_READY", "An individual product review is still being prepared. Recover its original proposal first.");
    }
    // Preparation replaces pending individual/older aggregate previews, never a
    // committed product. Reject before linking new batch so old approval cannot duplicate.
    for (const id of pendingIds) await this.catalog.rejectCatalogBatch(owner.businessId, id);
    for (const draft of drafts) if (draft.proposalId && !approvedIds.has(draft.id)) this.store.clearRejectedProposal(owner, callId, draft.id, draft.proposalId);
    drafts = this.store.listDrafts(owner, callId).filter(draft => !approvedIds.has(draft.id));
    const ready = drafts.filter(draft => draftReadiness(draft).ready);
    const incompleteDraftIds = drafts.filter(draft => !draftReadiness(draft).ready).map(draft => draft.id);
    const business = await this.catalog.getBusiness(owner.businessId);
    if (!business) return fail(404, "NOT_FOUND", "Business not found.");
    if (!ready.length && !(await this.catalog.listProducts(owner.businessId)).some(product => product.isPublished)) fail(409, "NOT_READY", "No complete products are ready. Your call is ended and drafts are saved; add missing product details or a photo before publishing.");
    const profile = { name: input.name, contactEmail: input.contactEmail, description: call.brief.description ?? business.description };
    const changes: ProductChange[] = ready.map(draft => ({ type: "create_product", product: productCreateInput.parse({ name: draft.fields.title, description: draft.fields.description, priceCents: draft.fields.priceMinor, inventoryCount: draft.fields.quantityOnHand, imageAssetId: draft.imageAssetId }) }));
    const patch: Record<string, string> = {};
    if (profile.name !== business.name) patch.name = profile.name;
    if (profile.contactEmail !== business.contactEmail) patch.contactEmail = profile.contactEmail;
    if (profile.description !== business.description && profile.description !== null) patch.description = profile.description;
    if (Object.keys(patch).length) changes.push({ type: "update_storefront", patch });
    if (!changes.length) return { proposal: null, noCatalogChanges: true, business: profile, productDraftIds: [] as string[], incompleteDraftIds };
    const snapshot = this.store.freezeCombinedReview(owner, callId, { requestKey: input.idempotencyKey, requestHash, expectedCatalogRevision: business.catalogRevision, business: profile, changes, draftRevisions: ready.map(draft => ({ id: draft.id, revision: draft.revision })), incompleteDraftIds });
    return this.finishCombinedReview(owner, callId, snapshot);
  }

  private async finishCombinedReview(owner: WorkspaceOwner, callId: string, snapshot: CallReviewSnapshot) {
    let proposal: CatalogBatchPreview | null;
    if (snapshot.proposalId) proposal = await this.catalog.getCatalogBatch(owner.businessId, snapshot.proposalId);
    else {
      try { proposal = await this.catalog.proposeCatalogBatch(owner.businessId, { callId, expectedCatalogRevision: snapshot.expectedCatalogRevision, idempotencyKey: `call-review/${snapshot.id}`, changes: snapshot.changes }); }
      catch (error) { if (error instanceof HttpError && error.status >= 400 && error.status < 500) this.store.releaseRejectedCombinedReview(owner, callId, snapshot); throw error; }
      this.store.linkCombinedReview(owner, callId, snapshot, proposal.id);
    }
    if (!proposal) return fail(409, "NOT_READY", "Combined review is unavailable. Reload before retrying.");
    return { proposal, noCatalogChanges: false, business: snapshot.business, productDraftIds: snapshot.draftRevisions.map(ref => ref.id), incompleteDraftIds: snapshot.incompleteDraftIds };
  }

  async tool(owner: WorkspaceOwner, callId: string, name: ClientToolName, raw: unknown, requestKey: string): Promise<unknown> {
    const call = this.store.assertActive(owner, callId);
    switch (name) {
      case "upsert_business_brief": return { call: this.store.updateBrief(owner, callId, parseClientToolArgs(name, raw)), saved: true, published: false, requiresOwnerReview: true };
      case "create_product_draft": {
        const args = parseClientToolArgs(name, raw);
        const draft = this.store.createDraft(owner, callId, requestKey, args.proposedTitle);
        return { productDraftId: draft.id, draft, ...draftReadiness(draft), saved: true, published: false };
      }
      case "record_product_details": {
        const { productDraftId, ...fields } = parseClientToolArgs(name, raw);
        if (fields.currencyCode && fields.currencyCode !== "USD") fail(400, "INVALID_INPUT", "This demo supports USD only. Confirm a USD price with the owner.");
        if (fields.inventoryTracked === false) fail(400, "INVALID_INPUT", "This demo requires an exact available quantity. Ask the owner; never invent stock.");
        return this.updateDraft(owner, callId, productDraftId, fields as DraftFields);
      }
      case "capture_product_photo": {
        const args = parseClientToolArgs(name, raw);
        this.store.getDraft(owner, callId, args.productDraftId);
        return { action: "capture_photo_in_browser", productDraftId: args.productDraftId, captured: false, saved: false, message: "Browser must capture/upload or offer file upload. Report success only after the draft-bound image endpoint returns captureId." };
      }
      case "get_catalog_summary": {
        parseClientToolArgs(name, raw);
        const business = await this.catalog.getBusiness(owner.businessId);
        if (!business) return fail(404, "NOT_FOUND", "Business not found.");
        return { business: { id: business.id, name: business.name, description: business.description, currencyCode: "USD", catalogRevision: business.catalogRevision, publishedUrl: business.publishedUrl }, products: await this.catalog.listProducts(owner.businessId), ...await this.current(owner, callId) };
      }
      case "resolve_product_reference": {
        const { phrase } = parseClientToolArgs(name, raw);
        const tokens = phrase.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(token => token && !["the", "a", "an", "one", "product", "item"].includes(token));
        const matches = (await this.catalog.listProducts(owner.businessId)).filter(product => tokens.length && tokens.every(token => product.name.toLowerCase().includes(token)));
        return { matches, needsClarification: matches.length !== 1, resolvedProductId: matches.length === 1 ? matches[0].id : null };
      }
      case "preview_catalog_changes": {
        const args = parseClientToolArgs(name, raw);
        const changes: ProductChange[] = [];
        for (const change of args.changes) {
          const product = await this.catalog.getProduct(owner.businessId, change.productId);
          if (!product) return fail(404, "NOT_FOUND", "Product not found.");
          if (change.type === "set_price") {
            if (change.currencyCode !== "USD") fail(400, "INVALID_INPUT", "This demo supports USD prices only.");
            changes.push({ type: "update_price", productId: product.id, priceCents: change.newPriceMinor, expectedRevision: product.revision });
          } else if (change.type === "set_quantity") changes.push({ type: "update_stock", productId: product.id, inventoryCount: change.newQuantity, expectedRevision: product.revision });
          else if (change.type === "adjust_quantity") changes.push({ type: "adjust_stock", productId: product.id, delta: change.delta, expectedRevision: product.revision });
          else changes.push({ type: "update_product", productId: product.id, patch: { isPublished: change.status === "active" }, expectedRevision: product.revision });
        }
        const business = await this.catalog.getBusiness(owner.businessId);
        if (!business) return fail(404, "NOT_FOUND", "Business not found.");
        const proposal = await this.catalog.proposeCatalogBatch(owner.businessId, { callId, expectedCatalogRevision: business.catalogRevision, idempotencyKey: requestKey, changes });
        return { proposal, applied: false, requiresOwnerReview: true };
      }
      case "show_confirmation": {
        const args = parseClientToolArgs(name, raw);
        if (args.kind === "publish") {
          if (args.proposalId !== call.publicationReviewId) fail(404, "NOT_FOUND", "Publication review not found for this call.");
          return { action: "show_publication_review", proposalId: args.proposalId, ...await this.current(owner, callId), approved: false, published: false };
        }
        const proposal = await this.catalog.getCatalogBatch(owner.businessId, args.proposalId);
        if (!proposal || proposal.callId !== callId) return fail(404, "NOT_FOUND", "Proposal not found for this call.");
        return { action: "show_catalog_review", proposal, approved: false, applied: false };
      }
      case "get_build_status": {
        const args = parseClientToolArgs(name, raw);
        return { job: await this.catalog.getBuildJob(owner.businessId, args.buildJobId) ?? fail(404, "NOT_FOUND", "Build job not found.") };
      }
    }
  }
}
