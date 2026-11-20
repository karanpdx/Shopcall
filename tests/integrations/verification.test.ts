import test from "node:test";
import assert from "node:assert/strict";
import { AnonymousStorefrontVerifier, allowedPublicUrl, type VerificationCatalog } from "../../src/integrations/publication/verification";
import { createStorefrontPlan } from "../../src/integrations/orchestrator";

const businessId = "f1fa84f0-c846-48ba-9cad-7bf073e906fb";
const productId = "1af3a039-4906-4e2e-978d-e4d166108fd0";
const origins = ["https://shop.replit.app", "https://catalog.example.com", "https://images.example.com"];
const plan = createStorefrontPlan({ businessId, businessName: "Studio", publicCatalogUrl: "https://catalog.example.com/catalog", catalogRevision: 1, approvedDesignBrief: "Green and cream ceramics." });
const catalog: VerificationCatalog = { business: { id: businessId, name: "Studio", description: "Ceramics", contactEmail: "hello@example.com", currencyCode: "USD" }, revision: 2, products: [{ id: productId, title: "Mug", description: "Blue", priceMinor: 2000, currencyCode: "USD", quantityOnHand: 4, inventoryTracked: true, imageUrl: "https://images.example.com/mug.jpg" }] };

function requests(overrides: { proxy?: unknown; htmlStatus?: number; imageType?: string; after?: unknown; cacheControl?: string } = {}) {
  let catalogReads = 0;
  return (async (input, init) => {
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "manual");
    const url = String(input);
    if (url === plan.brief.publicCatalogUrl) {
      catalogReads++;
      return Response.json(catalogReads > 1 ? overrides.after ?? catalog : catalog, { headers: { "cache-control": "no-store" } });
    }
    if (url.endsWith("/api/shopcall/catalog")) return Response.json(overrides.proxy ?? catalog, { headers: { "cache-control": overrides.cacheControl ?? "no-store" } });
    if (url.includes("images.example.com")) return new Response("image-bytes", { headers: { "content-type": overrides.imageType ?? "image/jpeg" } });
    return new Response(`<main data-shopcall-business="${businessId}" data-shopcall-revision="2"><article data-shopcall-product="${productId}"></article></main>`, { status: overrides.htmlStatus ?? 200, headers: { "cache-control": overrides.cacheControl ?? "no-store" } });
  }) as typeof fetch;
}

test("only configured public HTTPS origins; rejects credentials, literals, localhost and redirects", () => {
  for (const invalid of ["http://shop.replit.app", "https://attacker.example", "https://u:p@shop.replit.app", "https://127.0.0.1", "https://shop.replit.app/?token=secret", "https://api.local"]) {
    assert.throws(() => allowedPublicUrl(invalid, [...origins, "https://127.0.0.1", "https://api.local"]));
  }
  assert.equal(allowedPublicUrl("https://shop.replit.app/", origins).origin, origins[0]);
});

test("fresh canonical catalog, matching proxy, usable images and browser proof all required", async () => {
  let browserRuns = 0;
  const verifier = new AnonymousStorefrontVerifier(origins, { async inspect() { browserRuns++; return true; } }, requests());
  const proof = await verifier.verify("https://shop.replit.app/", plan, "app-1");
  assert.equal(proof.passed, true);
  assert.equal(proof.evidence[0].source, "browser-check");
  assert.equal(browserRuns, 1);
});

test("stale proxy, auth redirect, fake image and browser failure cannot verify publication", async () => {
  for (const options of [{ proxy: { ...catalog, revision: 1 } }, { htmlStatus: 302 }, { imageType: "text/html" }, { cacheControl: "public, max-age=86400" }]) {
    const verifier = new AnonymousStorefrontVerifier(origins, { async inspect() { return true; } }, requests(options));
    assert.equal((await verifier.verify("https://shop.replit.app/", plan, "app-1")).passed, false);
  }
  const verifier = new AnonymousStorefrontVerifier(origins, { async inspect() { return false; } }, requests());
  assert.equal((await verifier.verify("https://shop.replit.app/", plan, "app-1")).passed, false);
});

test("catalog change during verification forces fresh retry rather than accepting stale page", async () => {
  const verifier = new AnonymousStorefrontVerifier(origins, { async inspect() { return true; } }, requests({ after: { ...catalog, revision: 3 } }));
  assert.equal((await verifier.verify("https://shop.replit.app/", plan, "app-1")).passed, false);
});
