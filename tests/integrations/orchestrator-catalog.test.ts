import test from "node:test";
import assert from "node:assert/strict";
import { createStorefrontPlan, parseCanonicalCatalog, getExpectedPublicSlug } from "../../src/integrations/orchestrator";

const plan = createStorefrontPlan({
  businessId: "7138d322-3d2b-4491-a28b-107d006e7245", businessName: "Juniper",
  publicCatalogUrl: "https://api.shopcall.example/api/public/juniper/catalog", catalogRevision: 3,
  approvedDesignBrief: "Warm cream and green.",
});
const productId = "0db58dcc-354d-4f93-9a64-31ded7fab684";
function wire() {
  return { ok: true, data: {
    business: { slug: "juniper", name: "Juniper", description: null, heroTitle: null, heroSubtitle: null, primaryColor: "#203c33", contactEmail: "shop@example.com", currencyCode: "USD" },
    catalogRevision: 3,
    products: [{ id: productId, name: "Blue mug", description: null, category: "Ceramics", priceCents: 2400, inventoryCount: 4, soldOut: false, isFeatured: true, imageUrl: "https://api.shopcall.example/api/assets/mug", revision: 1, updatedAt: "2026-11-20T22:00:00Z" }],
    generatedAt: "2026-11-20T22:01:00Z",
  } };
}

test("normalizes actual B envelope to presentation catalog with approved-slug identity binding", () => {
  assert.equal(getExpectedPublicSlug(plan), "juniper");
  const parsed = parseCanonicalCatalog(wire(), plan);
  assert.deepEqual(parsed, {
    business: { id: plan.brief.businessId, name: "Juniper", description: "", contactEmail: "shop@example.com", currencyCode: "USD" },
    revision: 3,
    products: [{ id: productId, title: "Blue mug", description: "", priceMinor: 2400, currencyCode: "USD", quantityOnHand: 4, inventoryTracked: true, imageUrl: "https://api.shopcall.example/api/assets/mug" }],
  });
  assert.deepEqual(parseCanonicalCatalog(parsed, plan), parsed);
});

test("volatile generation/update metadata cannot make stable catalog comparisons fail", () => {
  const first = wire();
  const after = wire();
  after.data.generatedAt = "2026-11-20T22:02:00Z";
  after.data.products[0].updatedAt = "2026-11-20T22:02:00Z";
  after.data.products[0].revision = 2;
  assert.deepEqual(parseCanonicalCatalog(first, plan), parseCanonicalCatalog(after, plan));
  after.data.products[0].priceCents = 2000;
  assert.notDeepEqual(parseCanonicalCatalog(first, plan), parseCanonicalCatalog(after, plan));
});

test("cross-store slug, stale catalog, inconsistent stock, absent contact, duplicate IDs and errors fail closed", () => {
  const wrongStore = wire(); wrongStore.data.business.slug = "other";
  assert.throws(() => parseCanonicalCatalog(wrongStore, plan), /slug/);
  const stale = wire(); stale.data.catalogRevision = 2;
  assert.throws(() => parseCanonicalCatalog(stale, plan), /predates/);
  const inconsistent = wire(); inconsistent.data.products[0].soldOut = true;
  assert.throws(() => parseCanonicalCatalog(inconsistent, plan), /contradicts/);
  const noContact = wire(); (noContact.data.business as { contactEmail: string | null }).contactEmail = null;
  assert.throws(() => parseCanonicalCatalog(noContact, plan), /contact email/);
  const duplicates = wire(); duplicates.data.products.push({ ...duplicates.data.products[0] });
  assert.throws(() => parseCanonicalCatalog(duplicates, plan), /duplicate/);
  assert.throws(() => parseCanonicalCatalog({ ok: false, error: { code: "NOT_FOUND", message: "missing" } }, plan));
});

test("classic dialect retains tracked/untracked semantics and stable product order", () => {
  const normalized = parseCanonicalCatalog(wire(), plan);
  const second = { ...normalized.products[0], id: "f44dff3d-9fe4-4370-ac6b-a0dbcc81cf02", title: "Vase", inventoryTracked: false, quantityOnHand: null };
  normalized.products.unshift(second);
  const sorted = parseCanonicalCatalog(normalized, plan);
  assert.deepEqual(sorted.products.map(product => product.id), [productId, second.id]);
  assert.equal(sorted.products[1].inventoryTracked, false);
  const wrongClassic = { ...normalized, business: { ...normalized.business, id: "dddf6084-7952-49b7-8470-170c1947be34" } };
  assert.throws(() => parseCanonicalCatalog(wrongClassic, plan), /identity/);
});
