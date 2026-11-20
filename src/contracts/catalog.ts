import { z } from "zod";

export const id = z.uuid();
export const moneyMinor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const quantity = z.number().int().nonnegative().max(2147483647);
export const currency = z.string().regex(/^[A-Z]{3}$/);

export const productFields = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(4000),
  priceMinor: moneyMinor,
  currencyCode: currency,
  quantityOnHand: quantity.nullable(),
  inventoryTracked: z.boolean(),
}).strict().refine(p => p.inventoryTracked === (p.quantityOnHand !== null), {
  message: "Tracked inventory requires a quantity; untracked inventory requires null.",
});

export const product = productFields.safeExtend({
  id,
  businessId: id,
  revision: z.number().int().nonnegative(),
  status: z.enum(["draft", "active", "archived"]),
  imageUrl: z.url().nullable(),
});

export const catalogChange = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_price"), productId: id, newPriceMinor: moneyMinor, currencyCode: currency }).strict(),
  z.object({ type: z.literal("set_quantity"), productId: id, newQuantity: quantity }).strict(),
  z.object({ type: z.literal("adjust_quantity"), productId: id, delta: z.number().int().min(-2147483647).max(2147483647) }).strict(),
  z.object({ type: z.literal("set_status"), productId: id, status: z.enum(["active", "archived"]) }).strict(),
]);

export const proposedChanges = z.object({
  businessId: id,
  callId: id,
  expectedCatalogRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).max(160),
  changes: z.array(catalogChange).min(1).max(50),
}).strict();

export type Product = z.infer<typeof product>;
export type CatalogChange = z.infer<typeof catalogChange>;
export type ProposedChanges = z.infer<typeof proposedChanges>;
export type PublicProduct = Omit<Product, "businessId" | "revision" | "status">;
export type PublicCatalog = {
  business: { id: string; name: string; description: string; contactEmail: string; currencyCode: string };
  revision: number;
  products: PublicProduct[];
};
export type ApiResult<T> = { ok: true; data: T } | {
  ok: false;
  error: { code: "UNAUTHORIZED" | "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "NOT_READY" | "PROVIDER_ERROR"; message: string };
};
