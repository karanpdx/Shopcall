import { chromium } from "playwright-core";

// Opt-in live provider check: synthetic microphone, real authenticated SDK session.
// Do not log signed URLs, transcripts, frames or audio payloads.
if (!process.argv.includes("--live")) throw new Error("Pass --live to start one short real ElevenLabs session with a synthetic microphone.");
const base = new URL(process.env.APP_BASE_URL ?? "http://localhost:3000");
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["microphone"] });
let callId: string | undefined;
let audioReceived = false;
let providerConnected = false;
let providerDisconnected = false;
let cameraOffPreservedVoice = false;
try {
  const login = await context.request.post(new URL("/api/auth/login", base).href, {
    headers: { Origin: base.origin }, data: { email: process.env.DEMO_OWNER_EMAIL, password: process.env.DEMO_OWNER_PASSWORD },
  });
  if (!login.ok()) throw new Error("Live check login failed.");
  const page = await context.newPage();
  page.on("response", response => {
    if (new URL(response.url()).pathname === "/api/calls" && response.request().method() === "POST" && response.ok()) {
      void response.json().then(body => { callId = body.data?.call?.id; }).catch(() => {});
    }
  });
  page.on("websocket", socket => {
    if (!socket.url().startsWith("wss://api.elevenlabs.io/")) return;
    socket.on("close", () => { providerDisconnected = true; });
    socket.on("framereceived", event => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (frame.type === "conversation_initiation_metadata") providerConnected = true;
        if (frame.type === "audio") audioReceived = true;
      } catch { /* Binary/non-JSON frame, never logged. */ }
    });
  });
  await page.goto(base.href, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Start call", exact: true }).click({ timeout: 15_000 });
  const deadline = Date.now() + 20_000;
  while (!audioReceived && Date.now() < deadline) await page.waitForTimeout(200);
  if (!providerConnected || !audioReceived) throw new Error("Live check did not receive provider connection metadata and greeting audio within 20 seconds.");
  if (process.argv.includes("--camera")) {
    await page.getByRole("button", { name: "Turn camera on", exact: true }).click();
    await page.getByRole("button", { name: "Turn camera off", exact: true }).click();
    await page.waitForTimeout(500);
    cameraOffPreservedVoice = !providerDisconnected && await page.getByRole("button", { name: "Mute microphone", exact: true }).isEnabled();
    if (!cameraOffPreservedVoice) throw new Error("Camera shutdown interrupted the live voice session.");
  }
  console.log(JSON.stringify({ providerConnected, greetingAudioReceived: audioReceived, cameraOffPreservedVoice: process.argv.includes("--camera") ? cameraOffPreservedVoice : "not_checked", syntheticMicrophone: true, physicalPhoneVerified: false, catalogMutationsRequested: false }));
} catch {
  console.error(JSON.stringify({ liveVoiceCheckPassed: false, providerConnected, greetingAudioReceived: audioReceived, syntheticMicrophone: true }));
  process.exitCode = 1;
} finally {
  await context.pages()[0]?.getByRole("button", { name: "End call", exact: true }).click({ timeout: 3000 }).catch(() => {});
  if (callId) await context.request.post(new URL(`/api/calls/${callId}/end`, base).href, { headers: { Origin: base.origin } }).catch(() => {});
  await context.request.post(new URL("/api/auth/logout", base).href, { headers: { Origin: base.origin } }).catch(() => {});
  await browser.close();
}
