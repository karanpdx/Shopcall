import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { fail } from "../../server/http";
import { inventoryCount, priceCents } from "../../contracts/api";
import type { ProductChange } from "../../contracts/api";

export type WorkspaceOwner = { ownerId: string; businessId: string };
export const draftPatch = z.object({
  title: z.string().trim().min(1).max(160).optional(), description: z.string().max(4000).optional(),
  priceMinor: priceCents.optional(), currencyCode: z.literal("USD").optional(),
  quantityOnHand: inventoryCount.optional(), inventoryTracked: z.literal(true).optional(),
}).strict();
export type DraftFields = z.infer<typeof draftPatch>;
export const briefPatch = z.object({ name: z.string().trim().min(1).max(160).optional(), description: z.string().max(4000).optional(), style: z.string().max(2000).optional(), contactEmail: z.email().optional() }).strict();
export type BusinessBrief = z.infer<typeof briefPatch>;
export type WorkingCall = { id: string; ownerId: string; businessId: string; mode: "create" | "update"; status: "active" | "ended"; publicationReviewId: string; brief: BusinessBrief; createdAt: string; endedAt: string | null };
export type WorkingProductDraft = { id: string; callId: string; businessId: string; fields: DraftFields; imageAssetId: string | null; capturedAt: string | null; revision: number; proposalId: string | null; proposalRevision: number | null; proposalCatalogRevision: number | null; createdAt: string; updatedAt: string };
type CallRow = Omit<WorkingCall, "brief"> & { brief: string };
type DraftRow = Omit<WorkingProductDraft, "fields"> & { fields: string };
export type CallReviewSnapshot = { id: string; requestKey: string; requestHash: string; expectedCatalogRevision: number; business: { name: string; contactEmail: string; description: string | null }; changes: ProductChange[]; draftRevisions: { id: string; revision: number }[]; incompleteDraftIds: string[]; proposalId: string | null };
const timestamp = () => new Date().toISOString();

/** Additive workspace tables in B's DB. Canonical catalog is changed only by B's owner-confirmed batch API. */
export class CallWorkspaceStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS shopcall_calls_v1 (
      id TEXT PRIMARY KEY, ownerId TEXT NOT NULL REFERENCES owners(id), businessId TEXT NOT NULL REFERENCES businesses(id),
      mode TEXT NOT NULL CHECK(mode IN ('create','update')), status TEXT NOT NULL CHECK(status IN ('active','ended')),
      requestKey TEXT NOT NULL, publicationReviewId TEXT NOT NULL UNIQUE, brief TEXT NOT NULL DEFAULT '{}', createdAt TEXT NOT NULL, endedAt TEXT,
      UNIQUE(ownerId,businessId,requestKey)
    );
    CREATE TABLE IF NOT EXISTS shopcall_working_drafts_v1 (
      id TEXT PRIMARY KEY, callId TEXT NOT NULL REFERENCES shopcall_calls_v1(id), ownerId TEXT NOT NULL REFERENCES owners(id), businessId TEXT NOT NULL REFERENCES businesses(id),
      requestKey TEXT NOT NULL, fields TEXT NOT NULL, imageAssetId TEXT REFERENCES assets(id), capturedAt TEXT,
      revision INTEGER NOT NULL, proposalId TEXT, proposalRevision INTEGER, proposalCatalogRevision INTEGER, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      UNIQUE(callId,requestKey)
    );
    CREATE INDEX IF NOT EXISTS shopcall_working_drafts_call_v1 ON shopcall_working_drafts_v1(callId);
    CREATE TABLE IF NOT EXISTS shopcall_voice_attempts_v1 (ownerId TEXT NOT NULL, callId TEXT NOT NULL, attemptedAt TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS shopcall_voice_attempts_owner_v1 ON shopcall_voice_attempts_v1(ownerId,attemptedAt);`);
    db.exec(`CREATE TABLE IF NOT EXISTS shopcall_combined_reviews_v1 (
      id TEXT PRIMARY KEY,callId TEXT NOT NULL REFERENCES shopcall_calls_v1(id),ownerId TEXT NOT NULL,businessId TEXT NOT NULL,
      requestKey TEXT NOT NULL,requestHash TEXT NOT NULL,snapshot TEXT NOT NULL,proposalId TEXT,createdAt TEXT NOT NULL,
      UNIQUE(callId,requestKey)
    );`);
    const columns = db.prepare("PRAGMA table_info(shopcall_working_drafts_v1)").all() as { name: string }[];
    if (!columns.some(column => column.name === "proposalCatalogRevision")) db.exec("ALTER TABLE shopcall_working_drafts_v1 ADD COLUMN proposalCatalogRevision INTEGER");
  }

  private assertBusiness(owner: WorkspaceOwner) {
    if (!this.db.prepare("SELECT id FROM businesses WHERE id=? AND owner_id=?").get(owner.businessId, owner.ownerId)) fail(404, "NOT_FOUND", "Business not found.");
  }

  createCall(owner: WorkspaceOwner, input: { mode: "create" | "update"; idempotencyKey: string }): WorkingCall {
    z.object({ mode: z.enum(["create", "update"]), idempotencyKey: z.string().min(1).max(160) }).strict().parse(input);
    this.assertBusiness(owner);
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM shopcall_calls_v1 WHERE ownerId=? AND businessId=? AND requestKey=?").get(owner.ownerId, owner.businessId, input.idempotencyKey) as { id: string } | undefined;
      if (existing) {
        const call = this.getCall(owner, existing.id);
        if (call.mode !== input.mode) fail(409, "CONFLICT", "Call idempotency key was used for a different mode.");
        return call;
      }
      const id = randomUUID(); const now = timestamp();
      this.db.prepare("INSERT INTO shopcall_calls_v1 (id,ownerId,businessId,mode,status,requestKey,publicationReviewId,createdAt) VALUES (?,?,?,?,'active',?,?,?)").run(id, owner.ownerId, owner.businessId, input.mode, input.idempotencyKey, randomUUID(), now);
      return this.getCall(owner, id);
    }).immediate();
  }

  getCall(owner: WorkspaceOwner, callId: string): WorkingCall {
    z.uuid().parse(callId);
    this.assertBusiness(owner);
    const row = this.db.prepare("SELECT id,ownerId,businessId,mode,status,publicationReviewId,brief,createdAt,endedAt FROM shopcall_calls_v1 WHERE id=? AND ownerId=? AND businessId=?").get(callId, owner.ownerId, owner.businessId) as CallRow | undefined;
    if (!row) return fail(404, "NOT_FOUND", "Call not found.");
    return { ...row, brief: JSON.parse(row.brief) as BusinessBrief };
  }

  assertActive(owner: WorkspaceOwner, callId: string): WorkingCall {
    const call = this.getCall(owner, callId);
    if (call.status !== "active") fail(409, "CONFLICT", "Call has ended. Start a new call to use voice tools.");
    return call;
  }

  endCall(owner: WorkspaceOwner, callId: string): WorkingCall {
    this.getCall(owner, callId);
    this.db.prepare("UPDATE shopcall_calls_v1 SET status='ended', endedAt=COALESCE(endedAt,?) WHERE id=? AND ownerId=? AND businessId=?").run(timestamp(), callId, owner.ownerId, owner.businessId);
    return this.getCall(owner, callId);
  }

  updateBrief(owner: WorkspaceOwner, callId: string, input: BusinessBrief): WorkingCall {
    const patch = briefPatch.parse(input);
    return this.db.transaction(() => {
      const call = this.getCall(owner, callId);
      this.db.prepare("UPDATE shopcall_calls_v1 SET brief=? WHERE id=?").run(JSON.stringify({ ...call.brief, ...patch }), callId);
      return this.getCall(owner, callId);
    }).immediate();
  }

  listDrafts(owner: WorkspaceOwner, callId: string): WorkingProductDraft[] {
    this.getCall(owner, callId);
    const rows = this.db.prepare("SELECT id,callId,businessId,fields,imageAssetId,capturedAt,revision,proposalId,proposalRevision,proposalCatalogRevision,createdAt,updatedAt FROM shopcall_working_drafts_v1 WHERE callId=? AND ownerId=? AND businessId=? ORDER BY createdAt,id").all(callId, owner.ownerId, owner.businessId) as DraftRow[];
    return rows.map(row => ({ ...row, fields: JSON.parse(row.fields) as DraftFields }));
  }

  getDraft(owner: WorkspaceOwner, callId: string, draftId: string): WorkingProductDraft {
    z.uuid().parse(draftId);
    return this.listDrafts(owner, callId).find(row => row.id === draftId) ?? fail(404, "NOT_FOUND", "Product draft not found for this call.");
  }

  createDraft(owner: WorkspaceOwner, callId: string, requestKey: string, proposedTitle?: string): WorkingProductDraft {
    z.string().min(1).max(160).parse(requestKey);
    const fields = draftPatch.parse({ ...(proposedTitle ? { title: proposedTitle } : {}), currencyCode: "USD", inventoryTracked: true });
    return this.db.transaction(() => {
      this.getCall(owner, callId);
      const existing = this.db.prepare("SELECT id FROM shopcall_working_drafts_v1 WHERE callId=? AND requestKey=?").get(callId, requestKey) as { id: string } | undefined;
      if (existing) return this.getDraft(owner, callId, existing.id);
      const id = randomUUID(); const now = timestamp();
      this.db.prepare("INSERT INTO shopcall_working_drafts_v1 (id,callId,ownerId,businessId,requestKey,fields,revision,createdAt,updatedAt) VALUES (?,?,?,?,?,?,1,?,?)").run(id, callId, owner.ownerId, owner.businessId, requestKey, JSON.stringify(fields), now, now);
      return this.getDraft(owner, callId, id);
    }).immediate();
  }

  patchDraft(owner: WorkspaceOwner, callId: string, draftId: string, input: DraftFields): WorkingProductDraft {
    const patch = draftPatch.parse(input);
    return this.db.transaction(() => {
      const draft = this.getDraft(owner, callId, draftId);
      if (draft.proposalRevision !== null) fail(409, "CONFLICT", "Review or reject the existing proposal before editing this draft.");
      const next = { ...draft.fields, ...patch };
      if (JSON.stringify(next) === JSON.stringify(draft.fields)) return draft;
      this.db.prepare("UPDATE shopcall_working_drafts_v1 SET fields=?, revision=revision+1, updatedAt=? WHERE id=?").run(JSON.stringify(next), timestamp(), draftId);
      return this.getDraft(owner, callId, draftId);
    }).immediate();
  }

  attachImage(owner: WorkspaceOwner, callId: string, draftId: string, assetId: string, capturedAt: string): WorkingProductDraft {
    z.uuid().parse(assetId); z.iso.datetime({ offset: true }).parse(capturedAt);
    return this.db.transaction(() => {
      const draft = this.getDraft(owner, callId, draftId);
      if (draft.proposalRevision !== null) fail(409, "CONFLICT", "Review or reject the existing proposal before replacing its photo.");
      if (!this.db.prepare("SELECT id FROM assets WHERE id=? AND business_id=?").get(assetId, owner.businessId)) fail(404, "NOT_FOUND", "Image asset not found for this business.");
      if (draft.imageAssetId === assetId) return draft;
      this.db.prepare("UPDATE shopcall_working_drafts_v1 SET imageAssetId=?,capturedAt=?,revision=revision+1,updatedAt=? WHERE id=?").run(assetId, new Date(capturedAt).toISOString(), timestamp(), draftId);
      return this.getDraft(owner, callId, draftId);
    }).immediate();
  }

  linkProposal(owner: WorkspaceOwner, callId: string, draftId: string, draftRevision: number, proposalId: string) {
    z.uuid().parse(proposalId);
    const current = this.getDraft(owner, callId, draftId);
    if (current.revision !== draftRevision) return fail(409, "STALE_REVISION", "Draft changed while its proposal was prepared. Review the current draft.");
    this.db.prepare("UPDATE shopcall_working_drafts_v1 SET proposalId=?,proposalRevision=? WHERE id=? AND revision=?").run(proposalId, draftRevision, draftId, draftRevision);
    return this.getDraft(owner, callId, draftId);
  }

  reserveProposal(owner: WorkspaceOwner, callId: string, draftId: string, expectedDraftRevision: number, catalogRevision: number): WorkingProductDraft {
    return this.db.transaction(() => {
      const current = this.getDraft(owner, callId, draftId);
      if (current.revision !== expectedDraftRevision) fail(409, "STALE_REVISION", "Product draft changed before review could be prepared. Reload its current details.");
      if (current.proposalRevision !== null) return current;
      this.db.prepare("UPDATE shopcall_working_drafts_v1 SET proposalRevision=revision,proposalCatalogRevision=? WHERE id=?").run(catalogRevision, draftId);
      return this.getDraft(owner, callId, draftId);
    }).immediate();
  }

  releaseRejectedReservation(owner: WorkspaceOwner, callId: string, draftId: string, draftRevision: number) {
    this.getDraft(owner, callId, draftId);
    this.db.prepare("UPDATE shopcall_working_drafts_v1 SET proposalRevision=NULL,proposalCatalogRevision=NULL WHERE id=? AND proposalRevision=? AND proposalId IS NULL").run(draftId, draftRevision);
  }

  clearRejectedProposal(owner: WorkspaceOwner, callId: string, draftId: string, proposalId: string) {
    this.getDraft(owner, callId, draftId);
    this.db.prepare("UPDATE shopcall_working_drafts_v1 SET proposalId=NULL,proposalRevision=NULL,proposalCatalogRevision=NULL,revision=revision+1,updatedAt=? WHERE id=? AND proposalId=?").run(timestamp(), draftId, proposalId);
  }

  getCombinedReview(owner: WorkspaceOwner, callId: string, requestKey: string): CallReviewSnapshot | null {
    this.getCall(owner, callId);
    const row = this.db.prepare("SELECT snapshot,proposalId FROM shopcall_combined_reviews_v1 WHERE callId=? AND ownerId=? AND businessId=? AND requestKey=?").get(callId, owner.ownerId, owner.businessId, requestKey) as { snapshot: string; proposalId: string | null } | undefined;
    return row ? { ...JSON.parse(row.snapshot) as CallReviewSnapshot, proposalId: row.proposalId } : null;
  }

  getUnlinkedCombinedReview(owner: WorkspaceOwner, callId: string): CallReviewSnapshot | null {
    this.getCall(owner, callId);
    const row = this.db.prepare("SELECT snapshot FROM shopcall_combined_reviews_v1 WHERE callId=? AND ownerId=? AND businessId=? AND proposalId IS NULL ORDER BY createdAt LIMIT 1").get(callId, owner.ownerId, owner.businessId) as { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) as CallReviewSnapshot : null;
  }

  freezeCombinedReview(owner: WorkspaceOwner, callId: string, input: Omit<CallReviewSnapshot, "id" | "proposalId">): CallReviewSnapshot {
    return this.db.transaction(() => {
      this.getCall(owner, callId);
      const existing = this.getCombinedReview(owner, callId, input.requestKey);
      if (existing) {
        if (existing.requestHash !== input.requestHash) fail(409, "CONFLICT", "Review request key belongs to different business details.");
        return existing;
      }
      for (const ref of input.draftRevisions) {
        const draft = this.getDraft(owner, callId, ref.id);
        if (draft.revision !== ref.revision || draft.proposalRevision !== null) fail(409, "STALE_REVISION", "Products changed while combined review was prepared. Reload and review again.");
      }
      const snapshot: CallReviewSnapshot = { ...input, id: randomUUID(), proposalId: null };
      this.db.prepare("INSERT INTO shopcall_combined_reviews_v1(id,callId,ownerId,businessId,requestKey,requestHash,snapshot,createdAt) VALUES(?,?,?,?,?,?,?,?)").run(snapshot.id, callId, owner.ownerId, owner.businessId, snapshot.requestKey, snapshot.requestHash, JSON.stringify(snapshot), timestamp());
      for (const ref of input.draftRevisions) this.db.prepare("UPDATE shopcall_working_drafts_v1 SET proposalRevision=revision,proposalCatalogRevision=? WHERE id=?").run(input.expectedCatalogRevision, ref.id);
      return snapshot;
    }).immediate();
  }

  linkCombinedReview(owner: WorkspaceOwner, callId: string, snapshot: CallReviewSnapshot, proposalId: string) {
    return this.db.transaction(() => {
      this.getCall(owner, callId);
      for (const ref of snapshot.draftRevisions) this.linkProposal(owner, callId, ref.id, ref.revision, proposalId);
      this.db.prepare("UPDATE shopcall_combined_reviews_v1 SET proposalId=? WHERE id=? AND callId=? AND ownerId=? AND businessId=?").run(proposalId, snapshot.id, callId, owner.ownerId, owner.businessId);
    }).immediate();
  }

  releaseRejectedCombinedReview(owner: WorkspaceOwner, callId: string, snapshot: CallReviewSnapshot) {
    return this.db.transaction(() => {
      this.getCall(owner, callId);
      const row = this.getCombinedReview(owner, callId, snapshot.requestKey);
      if (!row || row.id !== snapshot.id || row.proposalId) return;
      for (const ref of snapshot.draftRevisions) this.releaseRejectedReservation(owner, callId, ref.id, ref.revision);
      this.db.prepare("DELETE FROM shopcall_combined_reviews_v1 WHERE id=? AND proposalId IS NULL").run(snapshot.id);
    }).immediate();
  }

  /** Durable rate-limit reservation before credential issuance; failures still count. */
  reserveVoiceAttempt(owner: WorkspaceOwner, callId: string, now = new Date()) {
    return this.db.transaction(() => {
      this.assertActive(owner, callId);
      const cutoff = new Date(now.getTime() - 60_000).toISOString();
      this.db.prepare("DELETE FROM shopcall_voice_attempts_v1 WHERE attemptedAt < ?").run(cutoff);
      const row = this.db.prepare("SELECT COUNT(*) AS count FROM shopcall_voice_attempts_v1 WHERE ownerId=? AND attemptedAt>=?").get(owner.ownerId, cutoff) as { count: number };
      if (row.count >= 5) fail(429, "RATE_LIMITED", "Too many voice reconnect attempts. Wait one minute.");
      this.db.prepare("INSERT INTO shopcall_voice_attempts_v1 (ownerId,callId,attemptedAt) VALUES (?,?,?)").run(owner.ownerId, callId, now.toISOString());
    }).immediate();
  }
}
