import { randomUUID } from "node:crypto";

const base = new URL(process.env.APP_BASE_URL ?? "http://localhost:3000");
if (!["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("Local smoke check requires a loopback app URL.");
let cookie = "";
let callId: string | undefined;
async function post(path: string, data?: unknown) {
  const response = await fetch(new URL(path, base), {
    method: "POST", redirect: "manual", headers: { Origin: base.origin, ...(cookie ? { Cookie: cookie } : {}), ...(data ? { "Content-Type": "application/json" } : {}) },
    body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Local route failed: ${path} HTTP ${response.status}`);
  return { response, data: result.data };
}
try {
  const login = await post("/api/auth/login", { email: process.env.DEMO_OWNER_EMAIL, password: process.env.DEMO_OWNER_PASSWORD });
  cookie = login.response.headers.get("set-cookie")?.split(";")[0] ?? "";
  if (!cookie) throw new Error("Local login returned no session cookie.");
  const session = await post("/api/calls", { mode: "create", idempotencyKey: `local-api-smoke/${randomUUID()}` });
  callId = session.data.call.id;
  const voice = await post("/api/voice/session", { callId });
  if (!voice.data.signedUrl?.startsWith("wss://api.elevenlabs.io/") || voice.response.headers.get("cache-control") !== "no-store") throw new Error("Voice session credential response invalid.");
  console.log(JSON.stringify({ localLogin: true, persistentCall: true, providerVoiceCredentialIssued: true, credentialCacheDisabled: true, microphoneUsed: false, conversationStarted: false }));
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith("Local route failed:") ? error.message : "Local API smoke failed; no microphone or conversation was started.");
  process.exitCode = 1;
} finally {
  if (callId && cookie) await post(`/api/calls/${callId}/end`).catch(() => {});
  if (cookie) await post("/api/auth/logout").catch(() => {});
}
