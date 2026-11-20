import test from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright-core";

const baseUrl = process.env.UI_BROWSER_TEST_URL;
const OWNER = "11111111-1111-4111-8111-111111111111";
const BUSINESS = "22222222-2222-4222-8222-222222222222";
const CALL = "33333333-3333-4333-8333-333333333333";

declare global {
  interface Window {
    __shopcallMediaTest: { cameraStops: number; cameraTracks: MediaStreamTrack[]; audioRequests: number };
  }
}

function installSyntheticMedia({ deniedAudio }: { deniedAudio: boolean }) {
    window.__shopcallMediaTest = { cameraStops: 0, cameraTracks: [], audioRequests: 0 };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async (constraints: MediaStreamConstraints) => {
      if (constraints.audio) {
        window.__shopcallMediaTest.audioRequests++;
        throw new DOMException(deniedAudio ? "Permission denied" : "Synthetic audio unavailable", deniedAudio ? "NotAllowedError" : "NotFoundError");
      }
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 480;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#356b55"; context.fillRect(0, 0, 640, 480);
      const stream = canvas.captureStream(15);
      for (const track of stream.getVideoTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => { window.__shopcallMediaTest.cameraStops++; stop(); };
        window.__shopcallMediaTest.cameraTracks.push(track);
      }
      return stream;
    } });
    Object.defineProperty(navigator.mediaDevices, "enumerateDevices", { configurable: true, value: async () => [] });
}

async function fixture(page: Page, deniedAudio = false) {
  // tsx preserves inferred function names using this helper inside serialized callbacks.
  await page.addInitScript({ content: "globalThis.__name = (fn) => fn;" });
  await page.addInitScript(installSyntheticMedia, { deniedAudio });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const session = { owner: { id: OWNER, email: "demo@example.com" }, business: { id: BUSINESS, slug: "demo", name: "Demo ceramics" }, expiresAt: "2099-01-01T00:00:00Z" };
    if (path === "/api/session") return route.fulfill({ json: { ok: true, data: session } });
    if (path === "/api/business") return route.fulfill({ json: { ok: true, data: { id: BUSINESS, name: "Demo ceramics", contactEmail: "shop@example.com", catalogRevision: 0 } } });
    if (path === "/api/calls") return route.fulfill({ json: { ok: true, data: { call: { id: CALL, status: "active", mode: "create", brief: {}, publicationReviewId: OWNER }, drafts: [] } } });
    if (path === "/api/voice/session") return route.fulfill({ status: 503, json: { ok: false, error: { code: "NOT_READY", message: "Synthetic test: voice provider intentionally not called." } } });
    if (path.endsWith("/end")) return route.fulfill({ json: { ok: true, data: { id: CALL, status: "ended", brief: {} } } });
    return route.fulfill({ status: 404, json: { ok: false, error: { code: "NOT_FOUND", message: "Synthetic test endpoint." } } });
  });
}

async function hitTest(page: Page, label: string) {
  return page.getByRole("button", { name: label, exact: true }).evaluate(button => {
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    return { inViewport: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth, clickable: !!top && button.contains(top), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 480 }]) {
  test(`camera remains a background; controls reachable and tracks stop at ${viewport.width}x${viewport.height}`, { skip: !baseUrl }, async () => {
    const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
    try {
      const page = await browser.newPage({ viewport });
      await fixture(page);
      await page.goto(baseUrl!);
      await page.getByRole("button", { name: "Turn camera on", exact: true }).waitFor();
      await page.evaluate(installSyntheticMedia, { deniedAudio: false });
      await page.getByRole("button", { name: "Turn camera on", exact: true }).click();
      await page.getByRole("button", { name: "Turn camera off", exact: true }).waitFor();
      const position = await page.locator("video.ft-video").evaluate(video => getComputedStyle(video).position);
      assert.equal(position, "absolute", "Camera must not enter the flex layout and push controls offscreen.");
      for (const label of ["Turn camera off", "End call", "Start voice call"]) {
        const result = await hitTest(page, label);
        assert.equal(result.inViewport && result.clickable, true, `${label} inaccessible: ${JSON.stringify(result)}`);
      }
      await page.getByRole("button", { name: "Turn camera off", exact: true }).click();
      const stopped = await page.evaluate(() => ({ count: window.__shopcallMediaTest.cameraStops, trackCount: window.__shopcallMediaTest.cameraTracks.length, allEnded: window.__shopcallMediaTest.cameraTracks.every(track => track.readyState === "ended"), previewRemoved: document.querySelector<HTMLVideoElement>("video.ft-video")?.srcObject === null }));
      assert.equal(stopped.count > 0 && stopped.allEnded && stopped.previewRemoved, true, JSON.stringify(stopped));
      assert.equal(await page.locator("video.ft-video").isVisible(), false);
    } finally { await browser.close(); }
  });
}

test("microphone start reports denied permission without creating a provider session", { skip: !baseUrl }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await fixture(page, true);
    let voiceRequests = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/voice/session") voiceRequests++; });
    await page.goto(baseUrl!);
    await page.getByRole("button", { name: "Start voice call", exact: true }).last().waitFor();
    await page.evaluate(installSyntheticMedia, { deniedAudio: true });
    const microphone = page.getByRole("button", { name: "Start voice call with microphone", exact: true });
    assert.equal(await microphone.isEnabled(), true);
    await microphone.click();
    await page.getByRole("alert").filter({ hasText: /microphone.*blocked|microphone.*permission/i }).waitFor({ timeout: 10_000 });
    assert.equal(await page.evaluate(() => window.__shopcallMediaTest.audioRequests), 1);
    assert.equal(voiceRequests, 0, "Denied microphone should be explained before consuming a voice session.");
  } finally { await browser.close(); }
});
