import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { EncryptedFileOAuthStore } from "../../src/integrations/replit/oauth-store";
import { ReplitOAuthService } from "../../src/integrations/replit/oauth";
import { ReplitMcpClient } from "../../src/integrations/replit/client";
import { parseCreationResult, parseReadinessResult, parsePublishResult, type ReplitResponseProfile } from "../../src/integrations/replit/results";
import type { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "shopcall-replit-"));
  const path = join(directory, "oauth.sqlite");
  const key = randomBytes(32).toString("base64");
  const store = new EncryptedFileOAuthStore(path, key);
  return { store, path, key, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("OAuth store encrypts tokens and isolates owners", async () => {
  const f = fixture();
  try {
    await f.store.updateConnection("owner-a", () => ({ tokens: { access_token: "secret-access-token", token_type: "Bearer" } }));
    assert.equal((await f.store.getConnection("owner-a")).tokens?.access_token, "secret-access-token");
    assert.deepEqual(await f.store.getConnection("owner-b"), {});
    assert.equal(readFileSync(f.path).includes(Buffer.from("secret-access-token")), false);
    const wrongKeyStore = new EncryptedFileOAuthStore(f.path, randomBytes(32).toString("base64"));
    await assert.rejects(wrongKeyStore.getConnection("owner-a"), /could not be decrypted/);
    wrongKeyStore.close();
  } finally { f.close(); }
});

test("OAuth state requires same owner, rejects expiry and is single use", async () => {
  const f = fixture();
  try {
    await f.store.putAttempt("owner-a", { state: "random-state", verifier: "pkce-value", expiresAt: 1000 });
    assert.equal(await f.store.consumeAttempt("owner-b", "random-state", 999), undefined);
    assert.equal(await f.store.consumeAttempt("owner-a", "wrong-state", 999), undefined);
    assert.equal(await f.store.consumeAttempt("owner-a", "random-state", 1000), undefined);
    const attempts = await Promise.all([f.store.consumeAttempt("owner-a", "random-state", 999), f.store.consumeAttempt("owner-a", "random-state", 999)]);
    assert.equal(attempts.filter(Boolean).length, 1);
  } finally { f.close(); }
});

test("OAuth service uses SDK PKCE and rejects cross-owner/replayed callback before exchange", async () => {
  const f = fixture();
  let issuedState = "";
  let exchanges = 0;
  const authorize: typeof auth = async (provider, options) => {
    if (options.authorizationCode) {
      exchanges++;
      assert.equal(await provider.codeVerifier(), "sdk-generated-pkce");
      await provider.saveTokens({ access_token: "access", token_type: "Bearer" });
      return "AUTHORIZED";
    }
    issuedState = await provider.state!();
    await provider.saveCodeVerifier("sdk-generated-pkce");
    await provider.redirectToAuthorization(new URL(`https://replit.com/oauth/authorize?state=${issuedState}`));
    return "REDIRECT";
  };
  try {
    const service = new ReplitOAuthService(f.store, "http://127.0.0.1:8788/api/replit/callback", authorize, () => 1);
    assert.equal((await service.begin("owner-a")).state, "redirect");
    await assert.rejects(service.complete("owner-b", issuedState, "code"), /invalid, expired, or already used/);
    assert.equal(exchanges, 0);
    await service.complete("owner-a", issuedState, "code");
    assert.equal(exchanges, 1);
    await assert.rejects(service.complete("owner-a", issuedState, "code"), /already used/);
    assert.equal(exchanges, 1);
    assert.throws(() => new ReplitOAuthService(f.store, "http://public.example/callback"), /fixed HTTPS/);
  } finally { f.close(); }
});

test("MCP client validates against discovered input schema and rejects missing capabilities", async () => {
  let calls = 0;
  const client = ReplitMcpClient.fromClient({
    listTools: async () => ({ tools: [{ name: "publish_app", inputSchema: { type: "object", properties: { replId: { type: "string", minLength: 1 } }, required: ["replId"], additionalProperties: false } }] }),
    callTool: async () => { calls++; return { content: [{ type: "text", text: "accepted" }] }; },
    close: async () => {},
  });
  await assert.rejects(client.publishApp(""), /discovered schema/);
  await assert.rejects(client.createApp({ appDescription: "hello", app_stack: "react_website" }), /capability unavailable/);
  assert.equal(calls, 0);
  await client.publishApp("app-id");
  assert.equal(calls, 1);
});

test("unverified output and agent prose cannot become build/publication success", () => {
  const prose = { content: [{ type: "text", text: '{"replId":"x","build":"done","status":"published","url":"https://example.com"}' }] };
  const profile: ReplitResponseProfile = { verifiedAt: "2026-11-20T00:00:00Z", creationIdPath: ["replId"], build: { statusPath: ["build"], readyValues: ["done"], pendingValues: ["building"], failedValues: ["failed"] }, publication: { statusPath: ["status"], urlPath: ["url"], readyValues: ["published"], pendingValues: ["publishing"], failedValues: ["failed"] } };
  assert.equal(parseCreationResult(prose).state, "blocked");
  assert.equal(parseReadinessResult(prose, profile).state, "blocked");
  assert.equal(parsePublishResult(prose, profile).state, "blocked");
  const structured = { content: [], structuredContent: { replId: "app-id", build: "building", status: "published", url: "http://localhost:3000" } };
  assert.deepEqual(parseCreationResult(structured, profile), { state: "created", replId: "app-id" });
  assert.equal(parseReadinessResult(structured, profile).state, "pending");
  assert.equal(parsePublishResult(structured, profile).state, "blocked");
});

test("provider errors never pass through as successful tool calls", async () => {
  const client = ReplitMcpClient.fromClient({
    listTools: async () => ({ tools: [{ name: "get_publish_status", inputSchema: { type: "object" } }] }),
    callTool: async () => ({ isError: true, content: [{ type: "text", text: "provider-secret" }] }),
    close: async () => {},
  });
  await assert.rejects(client.getPublishStatus("id"), error => error instanceof Error && !error.message.includes("provider-secret") && error.message.includes("provider error"));
});

test("artifact adapter rejects credential paths and validates actual preview arguments", async () => {
  const invoked: string[] = [];
  const client = ReplitMcpClient.fromClient({
    listTools: async () => ({ tools: [
      { name: "read_app_file", inputSchema: { type: "object", properties: { replId: { type: "string" }, path: { type: "string" } }, required: ["replId", "path"], additionalProperties: false } },
      { name: "list_app_files", inputSchema: { type: "object", properties: { replId: { type: "string" }, path: { type: "string" } }, required: ["replId"], additionalProperties: false } },
      { name: "replit_widget_get_preview_url", inputSchema: { type: "object", properties: { replId: { type: "string" }, gitSha: { type: "string" }, timestamp: { type: "string" } }, required: ["replId", "gitSha", "timestamp"], additionalProperties: false } },
    ] as Tool[] }),
    callTool: async ({ name }) => { invoked.push(name); return { content: [] }; },
    close: async () => {},
  });
  for (const privatePath of [".env.local", "../package.json", "/etc/passwd", "src/../credentials.json", "secrets/key.pem", "src/tokens.json", "src/server.key", "node_modules/pkg/index.js"]) {
    assert.throws(() => client.readAppFile("app", privatePath), /path|credential/);
  }
  await client.readAppFile("app", "src/App.tsx");
  await client.listAppFiles("app", "src/");
  await client.getPreviewUrl({ replId: "app", gitSha: "actual-observed-commit", timestamp: "actual-observed-timestamp" });
  assert.deepEqual(invoked, ["read_app_file", "list_app_files", "replit_widget_get_preview_url"]);
  await assert.rejects(client.call("replit_widget_get_auth_token", { replId: "app" }), /outside Shopcall/);
});
