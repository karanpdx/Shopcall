import { z } from "zod";
import { productFields } from "../../contracts/catalog";
import { assertPlanIntegrity, type StorefrontPlan } from "./plan";

const publicProduct = productFields.safeExtend({ id: z.uuid(), imageUrl: z.url().nullable() });
export const normalizedPublicCatalog = z.object({
  business: z.object({
    id: z.uuid(), name: z.string().min(1), description: z.string(), contactEmail: z.email(), currencyCode: z.string().regex(/^[A-Z]{3}$/),
  }).strict(),
  revision: z.number().int().nonnegative(),
  products: z.array(publicProduct).max(500),
}).strict();
export type NormalizedPublicCatalog = z.infer<typeof normalizedPublicCatalog>;

const backendCatalog = z.object({
  business: z.object({
    slug: z.string().min(1), name: z.string().min(1), description: z.string().nullable(),
    heroTitle: z.string().nullable(), heroSubtitle: z.string().nullable(), primaryColor: z.string().nullable(),
    contactEmail: z.email().nullable(), currencyCode: z.literal("USD"),
  }).strict(),
  catalogRevision: z.number().int().nonnegative(),
  products: z.array(z.object({
    id: z.uuid(), name: z.string().min(1), description: z.string().nullable(), category: z.string().nullable(),
    priceCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    inventoryCount: z.number().int().nonnegative(), soldOut: z.boolean(), isFeatured: z.boolean(),
    imageUrl: z.url().nullable(), revision: z.number().int().nonnegative(), updatedAt: z.iso.datetime({ offset: true }),
  }).strict()).max(500),
  generatedAt: z.iso.datetime({ offset: true }),
}).strict();

/** Public identity for B is the owner-approved endpoint slug, never an invented publicly returned UUID. */
export function getExpectedPublicSlug(plan: StorefrontPlan): string | null {
  const path = new URL(plan.brief.publicCatalogUrl).pathname;
  const match = /^\/api\/public\/([^/]+)\/catalog\/?$/.exec(path);
  if (!match) return null;
  try {
    const slug = decodeURIComponent(match[1]);
    return /^[a-z0-9][a-z0-9-]{0,159}$/.test(slug) ? slug : null;
  } catch { return null; }
}

/**
 * A stable presentation projection of the canonical response, not a second catalog authority.
 * B's generatedAt and product revision/update metadata are volatile/non-rendered and excluded.
 */
export function parseCanonicalCatalog(raw: unknown, plan: StorefrontPlan): NormalizedPublicCatalog {
  assertPlanIntegrity(plan);
  let result: NormalizedPublicCatalog;
  if (typeof raw === "object" && raw !== null && "ok" in raw) {
    const envelope = z.object({ ok: z.literal(true), data: backendCatalog }).strict().parse(raw);
    const catalog = envelope.data;
    const expectedSlug = getExpectedPublicSlug(plan);
    if (!expectedSlug || catalog.business.slug !== expectedSlug) throw new Error("Public catalog slug differs from approved endpoint identity.");
    if (!catalog.business.contactEmail) throw new Error("Owner-approved public contact email is required for contact-to-buy.");
    if (catalog.products.some(product => product.soldOut !== (product.inventoryCount === 0))) throw new Error("Catalog sold-out state contradicts canonical inventory.");
    result = normalizedPublicCatalog.parse({
      business: {
        // The trusted approved endpoint + matched public slug binds this internal stable ID.
        id: plan.brief.businessId,
        name: catalog.business.name,
        description: catalog.business.description ?? "",
        contactEmail: catalog.business.contactEmail,
        currencyCode: catalog.business.currencyCode,
      },
      revision: catalog.catalogRevision,
      products: catalog.products.map(product => ({
        id: product.id, title: product.name, description: product.description ?? "", priceMinor: product.priceCents,
        currencyCode: catalog.business.currencyCode, quantityOnHand: product.inventoryCount, inventoryTracked: true, imageUrl: product.imageUrl,
      })),
    });
  } else {
    result = normalizedPublicCatalog.parse(raw);
    if (result.business.id !== plan.brief.businessId) throw new Error("Catalog business identity differs from approved snapshot.");
  }
  if (result.revision < plan.brief.catalogRevision) throw new Error("Catalog revision predates approved snapshot.");
  const ids = new Set(result.products.map(product => product.id));
  if (ids.size !== result.products.length) throw new Error("Canonical catalog contains duplicate product IDs.");
  // Generated frontend/proxy use the same stable ordering, avoiding incidental SQL ordering drift.
  result.products.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
