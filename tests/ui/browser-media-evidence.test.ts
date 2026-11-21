import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import type { MediaJobView } from "../../src/features/call/media";

const url = process.env.UI_BROWSER_TEST_URL;
test("owner sees generated suggestions/photos before explicitly applying; original and camera-off state survive", { skip: !url }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const businessId = "22222222-2222-4222-8222-222222222222";
  const callId = "33333333-3333-4333-8333-333333333333";
  const draftId = "55555555-5555-4555-8555-555555555555";
  const original = "77777777-7777-4777-8777-777777777777";
  const enhanced = "88888888-8888-4888-8888-888888888888";
  const draft = { id: draftId, callId, fields: { title: "Mug", description: "Owner description", priceMinor: 2400, quantityOnHand: 4, currencyCode: "USD", inventoryTracked: true }, imageAssetId: original, imageUrl: `/api/assets/${original}`, revision: 5, proposalId: null, ready: true };
  const job: MediaJobView = { id: "media-job", productDraftId: draftId, originalAssetId: original, originalUrl: `/api/assets/${original}`, enhancedAssetId: enhanced, enhancedUrl: `/api/assets/${enhanced}`, sourceDraftRevision: 2, currentDraftRevision: 2, analysisStatus: "ready", enhancementStatus: "ready", selectedVariant: "original", suggestedTitle: "Blue glazed mug", suggestedDescription: "Blue glaze and a curved handle.", titleApplied: false, descriptionApplied: false, errorCode: null, evidence: { analysisModel: "fixture", enhancementModel: "fixture", analysisStartedAt: null, analysisCompletedAt: null, enhancementStartedAt: null, enhancementCompletedAt: null }, createdAt: "2026-11-20T22:00:00Z", updatedAt: "2026-11-20T22:00:00Z" };
  const choices: Record<string, unknown>[] = [];
  let mediaReadyAt: number | null = null;
  let signedOut = false;
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript(({ callId }) => { sessionStorage.setItem("shopcall:working-call", callId); }, { callId });
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      const respond = (data: unknown) => route.fulfill({ json: { ok: true, data } });
      if (path === "/api/session") return signedOut ? route.fulfill({ status: 401, json: { ok: false, error: { code: "UNAUTHORIZED", message: "Sign in required" } } }) : respond({ owner: { id: ownerId, email: "owner@example.com" }, business: { id: businessId, name: "Ceramics", slug: "ceramics" }, expiresAt: "2099-01-01T00:00:00Z" });
      if (path === "/api/auth/logout") { signedOut = true; return respond({ signedOut: true }); }
      if (path === "/api/business") return respond({ id: businessId, name: "Ceramics", contactEmail: "owner@example.com", catalogRevision: 0 });
      if (path === `/api/calls/${callId}`) return respond({ call: { id: callId, status: "ended", brief: {}, publicationReviewId: ownerId }, drafts: [draft] });
      if (path === `/api/calls/${callId}/end`) return respond({ id: callId, status: "ended", brief: {} });
      if (path.endsWith("/media/choice")) {
        const choice = route.request().postDataJSON(); choices.push(choice);
        assert.equal(choice.expectedDraftRevision, draft.revision);
        if (choice.applyTitle) { draft.fields.title = job.suggestedTitle!; job.titleApplied = true; }
        if (choice.applyDescription) { draft.fields.description = job.suggestedDescription!; job.descriptionApplied = true; }
        if (choice.useEnhanced !== undefined) { job.selectedVariant = choice.useEnhanced ? "enhanced" : "original"; draft.imageAssetId = choice.useEnhanced ? enhanced : original; }
        draft.revision++; job.currentDraftRevision = draft.revision;
        return respond({ job });
      }
      if (path.endsWith("/media")) {
        mediaReadyAt ??= Date.now() + 500;
        return respond({ job: Date.now() < mediaReadyAt ? { ...job, analysisStatus: "running", enhancementStatus: "queued", enhancedAssetId: null, enhancedUrl: null, suggestedTitle: null, suggestedDescription: null } : job });
      }
      if (path.startsWith("/api/assets/")) return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVPsAAAAASUVORK5CYII=", "base64") });
      return route.fulfill({ status: 404, json: { ok: false, error: { code: "NOT_FOUND", message: "Fixture endpoint" } } });
    });
    await page.goto(url!);
    await page.getByRole("button", { name: "Analyzing photo… for Mug. Open products", exact: true }).waitFor();
    const livePreview = page.getByRole("button", { name: "Enhanced preview ready for Mug. Open products", exact: true });
    await livePreview.waitFor();
    assert.equal(await page.getByRole("img", { name: "Generated preview", exact: true }).getAttribute("src"), `/api/assets/${enhanced}`);
    assert.equal(choices.length, 0, "Main-call generated preview must not silently select or apply output.");
    await livePreview.click();
    await page.getByText("Blue glazed mug", { exact: true }).waitFor();
    assert.equal(choices.length, 0, "Seeing generated output must not silently apply it.");
    assert.equal(await page.getByRole("button", { name: "Start call", exact: true }).count(), 1);
    assert.equal(await page.locator("video.ft-video").isVisible(), false);
    await page.getByRole("button", { name: "Apply suggestions", exact: true }).click();
    await page.getByRole("button", { name: "Suggestions applied", exact: true }).waitFor();
    assert.equal(draft.fields.title, "Mug", "Owner-stated name must not be overwritten by an image suggestion.");
    assert.equal(draft.fields.description, job.suggestedDescription);
    assert.equal(choices[0].expectedDraftRevision, 5, "Use the current draft revision even when completed media projection is older.");
    assert.equal(choices[0].applyTitle, false);
    assert.equal(choices[0].applyDescription, true);
    await page.getByRole("button", { name: "Use enhanced photo", exact: true }).click();
    await page.getByRole("button", { name: "Keep original", exact: true }).waitFor();
    const originalImage = page.getByRole("img", { name: /Original photo of/ });
    assert.equal(await originalImage.getAttribute("src"), `/api/assets/${original}`);
    assert.equal(draft.fields.priceMinor, 2400); assert.equal(draft.fields.quantityOnHand, 4);
    await page.getByRole("button", { name: "Keep original", exact: true }).click();
    await page.getByText("Original · selected", { exact: true }).waitFor();
    assert.equal(job.selectedVariant, "original");
    assert.equal(await page.locator("video.ft-video").isVisible(), false);
    assert.deepEqual(choices.map(choice => choice.useEnhanced).filter(value => value !== undefined), [true, false]);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("heading", { name: "Sign in to your store", exact: true }).waitFor();
    assert.equal(signedOut, true);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("shopcall:working-call")), null);
  } finally { await browser.close(); }
});
