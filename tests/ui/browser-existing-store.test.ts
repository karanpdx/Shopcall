import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const baseUrl = process.env.UI_BROWSER_TEST_URL;
for (const existingUrl of ["https://existing-store.replit.app/", null]) {
  test(existingUrl ? "new product approval keeps verified storefront URL without another Replit build" : "first storefront still queues a build after owner approval", { skip: !baseUrl }, async () => {
    const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
    const owner = "11111111-1111-4111-8111-111111111111";
    const businessId = "22222222-2222-4222-8222-222222222222";
    const callId = "33333333-3333-4333-8333-333333333333";
    const draftId = "44444444-4444-4444-8444-444444444444";
    const assetId = "55555555-5555-4555-8555-555555555555";
    const batchId = "66666666-6666-4666-8666-666666666666";
    const jobId = "77777777-7777-4777-8777-777777777777";
    const business = { id: businessId, name: "Ceramics", contactEmail: "shop@example.com", description: null, catalogRevision: 5, publishedUrl: existingUrl };
    const draft = { id: draftId, callId, fields: { title: "White bowl", description: "White glaze", priceMinor: 3200, quantityOnHand: 2, currencyCode: "USD", inventoryTracked: true }, imageAssetId: assetId, imageUrl: `/api/assets/${assetId}`, revision: 2, proposalId: null as string | null, ready: true };
    const batch = { id: batchId, callId, businessId, expectedCatalogRevision: 5, status: "pending", draftIds: [draftId], changes: [{ type: "create_product", product: { name: "White bowl", description: "White glaze", priceCents: 3200, inventoryCount: 2, imageAssetId: assetId } }], summary: ["Add White bowl: USD 32.00, stock 2"], expiresAt: "2099-01-01T00:00:00Z", createdAt: "2026-11-20T22:00:00Z", resolvedAt: null as string | null };
    let applications = 0; let builds = 0; let endRequests = 0;
    const products: Record<string, unknown>[] = existingUrl ? [{ id: owner, name: "Blue mug", priceCents: 2400, inventoryCount: 4, isPublished: true, revision: 1 }] : [];
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.addInitScript(({ callId }) => { sessionStorage.setItem("shopcall:working-call", callId); }, { callId });
      await page.route("**/api/**", async route => {
        const path = new URL(route.request().url()).pathname;
        const respond = (data: unknown) => route.fulfill({ json: { ok: true, data } });
        if (path === "/api/session") return respond({ owner: { id: owner, email: "shop@example.com" }, business: { id: businessId, name: "Ceramics", slug: "ceramics" }, expiresAt: "2099-01-01T00:00:00Z" });
        if (path === "/api/business") return respond(business);
        if (path === "/api/products") return respond(products);
        if (path === `/api/calls/${callId}`) return respond({ call: { id: callId, status: "ended", brief: {}, publicationReviewId: owner }, drafts: [draft] });
        if (path === `/api/calls/${callId}/end`) { endRequests++; return respond({ id: callId, status: "ended", brief: {} }); }
        if (path === `/api/calls/${callId}/review`) return respond({ proposal: batch, noCatalogChanges: false, business: { name: business.name, contactEmail: business.contactEmail, description: null }, productDraftIds: [draftId], incompleteDraftIds: [] });
        if (path.endsWith("/media")) return respond({ job: null });
        if (path === `/api/catalog/proposals/${batchId}/review`) return respond({ batch, confirmationToken: "owner-only-confirmation-fixture-token" });
        if (path === `/api/catalog/proposals/${batchId}/confirm`) {
          const input = route.request().postDataJSON();
          assert.equal(input.confirmationToken, "owner-only-confirmation-fixture-token");
          assert.equal(applications, 0, "One owner click must not apply the new product twice.");
          applications++; batch.status = "approved"; batch.resolvedAt = "2026-11-20T22:01:00Z"; business.catalogRevision++; draft.proposalId = batchId;
          products.push({ id: draftId, name: "White bowl", priceCents: 3200, inventoryCount: 2, isPublished: true, revision: 1 });
          return respond(batch);
        }
        if (path === `/api/catalog/proposals/${batchId}`) return respond(batch);
        if (path === "/api/builds") {
          builds++;
          assert.equal(route.request().postDataJSON().expectedCatalogRevision, 6);
          return respond({ id: jobId, businessId, provider: "replit", providerJobId: null, buildStatus: "queued", publicationStatus: "pending", publicUrl: null, errorMessage: null, createdAt: "2026-11-20T22:01:00Z", updatedAt: "2026-11-20T22:01:00Z" });
        }
        if (path === `/api/builds/${jobId}`) return respond({ id: jobId, businessId, provider: "replit", providerJobId: null, buildStatus: "queued", publicationStatus: "pending", publicUrl: null, errorMessage: null, createdAt: "2026-11-20T22:01:00Z", updatedAt: "2026-11-20T22:01:00Z" });
        if (path.startsWith("/api/assets/")) return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVPsAAAAASUVORK5CYII=", "base64") });
        return route.fulfill({ status: 404, json: { ok: false, error: { code: "NOT_FOUND", message: "Fixture endpoint" } } });
      });
      await page.goto(baseUrl!);
      await page.getByRole("button", { name: "Finish & review", exact: true }).click();
      await page.getByRole("button", { name: "Review & publish", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Publish your storefront?", exact: true });
      await dialog.waitFor();
      assert.equal(applications, 0, "Preparing review must not apply the product.");
      await dialog.getByRole("checkbox", { name: "The product photos, names, prices and stock above", exact: true }).check();
      await dialog.getByRole("checkbox", { name: "My contact email: shop@example.com", exact: true }).check();
      await dialog.getByRole("button", { name: "Confirm and publish", exact: true }).click();
      if (existingUrl) {
        const link = page.getByRole("link", { name: "Open storefront", exact: true });
        await link.waitFor();
        assert.equal(await link.getAttribute("href"), existingUrl);
        assert.equal(builds, 0);
        assert.equal(business.publishedUrl, existingUrl);
      } else {
        await page.waitForURL(`**/status?job=${jobId}`);
        assert.equal(builds, 1);
      }
      assert.equal(applications, 1);
      assert.equal(business.catalogRevision, 6);
      assert.ok(endRequests > 0);
      assert.equal(await page.locator("video.ft-video").isVisible(), false);
    } finally { await browser.close(); }
  });
}
