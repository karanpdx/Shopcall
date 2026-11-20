import { z } from "zod";
import { productChange, revision } from "../../contracts/api";

export const proposeCatalogBatchInput = z.object({
  callId: z.uuid(), expectedCatalogRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().trim().min(1).max(160),
  changes: z.array(productChange).min(1).max(50),
}).strict();
export const approveCatalogBatchInput = z.object({
  confirmationToken: z.string().min(32).max(160), idempotencyKey: z.string().trim().min(1).max(160),
}).strict();
export type ProposeCatalogBatchInput = z.infer<typeof proposeCatalogBatchInput>;
export type ApproveCatalogBatchInput = z.infer<typeof approveCatalogBatchInput>;
export type CatalogBatch = {
  id: string; businessId: string; callId: string; expectedCatalogRevision: number;
  status: "pending" | "approved" | "rejected";
  draftIds: string[]; changes: z.infer<typeof productChange>[];
  summary: string[]; expiresAt: string; createdAt: string; resolvedAt: string | null;
};
