import { z } from "zod";

/**
 * Implemented API contract (Lane B). Field names match the JSON returned by `src/app/api/**`.
 * `catalog.ts` holds the earlier v0 proposal; new consumers should use this file.
 * Money is integer USD cents; inventory is a nonnegative integer.
 */

export const uuid = z.uuid();
export const priceCents = z.number().int().nonnegative().max(1_000_000_000);
export const inventoryCount = z.number().int().nonnegative().max(1_000_000);
export const revision = z.number().int().positive();
const timestamp = z.string(); // UTC ISO-8601
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Expected #RRGGBB");

export const apiErrorCode = z.enum([
  "UNAUTHORIZED", "FORBIDDEN", "INVALID_INPUT", "NOT_FOUND", "CONFLICT", "STALE_REVISION",
  "PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE", "RATE_LIMITED",
  "CONFIGURATION_ERROR", "STORAGE_ERROR", "NOT_READY", "PROVIDER_ERROR", "INTERNAL",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCode>;
export const apiError = z.object({ ok: z.literal(false), error: z.object({ code: apiErrorCode, message: z.string() }) });
export type ApiError = z.infer<typeof apiError>;
export type ApiResult<T> = { ok: true; data: T } | ApiError;

// ---- Entities ----

export const business = z.object({
  id: uuid,
  ownerId: uuid,
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  heroTitle: z.string().nullable(),
  heroSubtitle: z.string().nullable(),
  primaryColor: z.string().nullable(),
  contactEmail: z.string().nullable(),
  /** Null when PUBLIC_API_BASE is not configured. */
  publicCatalogUrl: z.string().nullable(),
  /** Set only after the provider reported AND verified publication. */
  publishedUrl: z.string().nullable(),
  /** Increments on every approved catalog/storefront mutation. */
  catalogRevision: z.number().int().nonnegative(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Business = z.infer<typeof business>;

export const product = z.object({
  id: uuid,
  businessId: uuid,
  name: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  priceCents,
  inventoryCount,
  /** Derived: inventoryCount === 0. Not stored. */
  soldOut: z.boolean(),
  imageAssetId: uuid.nullable(),
  imageUrl: z.string().nullable(),
  isPublished: z.boolean(),
  isFeatured: z.boolean(),
  revision,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Product = z.infer<typeof product>;

export const asset = z.object({
  id: uuid,
  businessId: uuid,
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  sizeBytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  url: z.string(),
  createdAt: timestamp,
});
export type Asset = z.infer<typeof asset>;

// ---- Product changes (draft payloads) ----

const name = z.string().trim().min(1).max(160);
const description = z.string().trim().max(4000);
const category = z.string().trim().min(1).max(80);

export const productCreateInput = z.object({
  name,
  description: description.optional(),
  category: category.optional(),
  priceCents,
  inventoryCount,
  imageAssetId: uuid.optional(),
}).strict();
export type ProductCreateInput = z.infer<typeof productCreateInput>;

export const productUpdatePatch = z.object({
  name: name.optional(),
  description: description.optional(),
  category: category.optional(),
  isFeatured: z.boolean().optional(),
  isPublished: z.boolean().optional(),
}).strict().refine(p => Object.keys(p).length > 0, "Patch must change at least one field");

export const storefrontPatch = z.object({
  name: name.optional(),
  description: description.optional(),
  heroTitle: z.string().trim().max(160).optional(),
  heroSubtitle: z.string().trim().max(400).optional(),
  primaryColor: hexColor.optional(),
  contactEmail: z.email().optional(),
}).strict().refine(p => Object.keys(p).length > 0, "Patch must change at least one field");

export const productChange = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_product"), product: productCreateInput }).strict(),
  z.object({ type: z.literal("update_price"), productId: uuid, priceCents, expectedRevision: revision }).strict(),
  z.object({ type: z.literal("update_stock"), productId: uuid, inventoryCount, expectedRevision: revision }).strict(),
  z.object({
    type: z.literal("adjust_stock"), productId: uuid,
    delta: z.number().int().min(-1_000_000).max(1_000_000).refine(d => d !== 0, "delta must be nonzero"),
    expectedRevision: revision,
  }).strict(),
  z.object({ type: z.literal("update_product"), productId: uuid, patch: productUpdatePatch, expectedRevision: revision }).strict(),
  z.object({ type: z.literal("update_storefront"), patch: storefrontPatch }).strict(),
]);
export type ProductChange = z.infer<typeof productChange>;
export type DraftOperation = ProductChange["type"];

export const draftStatus = z.enum(["pending", "approved", "rejected"]);
export type DraftStatus = z.infer<typeof draftStatus>;

export const draft = z.object({
  id: uuid,
  businessId: uuid,
  operation: z.enum(["create_product", "update_price", "update_stock", "adjust_stock", "update_product", "update_storefront"]),
  /** Product ID (or created product ID after approval); business ID for update_storefront. */
  targetId: uuid.nullable(),
  /** Snapshot of the affected fields when the draft was created; null for create_product. */
  previousValues: z.record(z.string(), z.unknown()).nullable(),
  proposedValues: productChange,
  expectedRevision: z.number().int().nullable(),
  status: draftStatus,
  createdAt: timestamp,
  resolvedAt: timestamp.nullable(),
});
export type Draft = z.infer<typeof draft>;

export type DraftApprovalResponse = { draft: Draft; product: Product | null; business: Business | null };

// ---- Session ----

export const loginInput = z.object({ email: z.email(), password: z.string().min(1).max(200) }).strict();
export type Session = {
  owner: { id: string; email: string };
  business: { id: string; slug: string; name: string };
  expiresAt: string;
};

// ---- Public catalog (anonymous, read-only) ----

export type PublicProduct = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  priceCents: number;
  inventoryCount: number;
  soldOut: boolean;
  isFeatured: boolean;
  imageUrl: string | null;
  revision: number;
  updatedAt: string;
};
export type PublicCatalog = {
  business: {
    slug: string; name: string; description: string | null;
    heroTitle: string | null; heroSubtitle: string | null; primaryColor: string | null;
    contactEmail: string | null; currencyCode: "USD";
  };
  catalogRevision: number;
  products: PublicProduct[];
  generatedAt: string;
};

// ---- Build jobs ----

export const buildStatus = z.enum(["queued", "running", "completed", "failed"]);
export const publicationStatus = z.enum(["pending", "completed", "failed"]);
export type BuildStatus = z.infer<typeof buildStatus>;
export type PublicationStatus = z.infer<typeof publicationStatus>;

export const buildJobRequest = z.object({ designBrief: z.string().trim().max(4000).optional(), expectedCatalogRevision: z.number().int().nonnegative().optional() }).strict();
export type BuildJobRequest = z.infer<typeof buildJobRequest>;

export type BuildJob = {
  id: string;
  businessId: string;
  provider: string;
  providerJobId: string | null;
  buildStatus: BuildStatus;
  publicationStatus: PublicationStatus;
  /** Null until publicationStatus === "completed". */
  publicUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export const buildJobUpdate = z.object({
  providerJobId: z.string().min(1).max(200).optional(),
  buildStatus: buildStatus.optional(),
  publicationStatus: publicationStatus.optional(),
  /** Only accepted together with publicationStatus "completed", after anonymous verification. */
  publicUrl: z.url({ protocol: /^https?$/ }).optional(),
  errorMessage: z.string().max(1000).optional(),
}).strict();
export type BuildJobUpdate = z.infer<typeof buildJobUpdate>;

/** Frozen at POST /api/builds; what the worker hands to the storefront generator. */
export type BuildSpec = {
  jobId: string;
  businessId: string;
  businessName: string;
  slug: string;
  publicCatalogUrl: string;
  catalogRevision: number;
  designBrief: string;
  approvedByOwnerId: string;
  approvedAt: string;
};

/**
 * Repository seam for Lane C (worker, provider adapters). Implemented by `src/server/repository.ts`.
 * Lane C must not need route files; everything a worker needs is here.
 */
export interface ShopCallRepository {
  getBusiness(businessId: string): Promise<Business | null>;
  listProducts(businessId: string): Promise<Product[]>;
  getProduct(businessId: string, productId: string): Promise<Product | null>;
  createDraft(businessId: string, change: ProductChange): Promise<Draft>;
  getBuildJob(businessId: string, jobId: string): Promise<BuildJob | null>;
  /** Atomically moves the oldest queued job to buildStatus "running" and returns its frozen spec. */
  claimNextBuildJob(): Promise<{ job: BuildJob; spec: BuildSpec } | null>;
  /** Enforces legal state transitions; throws on illegal ones. */
  updateBuildJob(jobId: string, update: BuildJobUpdate): Promise<BuildJob>;
}
