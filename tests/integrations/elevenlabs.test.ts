import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHOPCALL_AGENT_NAME, SHOPCALL_AGENT_TAG, shopcallAgentConfig } from "../../src/integrations/elevenlabs/config";
import { issueVoiceSession, provisionShopcallAgent, type VoiceProvider } from "../../src/integrations/elevenlabs/service";
import { parseClientToolArgs, shopcallClientTools } from "../../src/integrations/elevenlabs/tools";
import { CLIENT_TOOL_NAMES } from "../../src/contracts/integrations";
import { ElevenLabsError } from "@elevenlabs/elevenlabs-js";

const ids = { ownerUserId: "b173ca88-020d-4bcc-b774-812fc4e029ed", businessId: "b173ca88-020d-4bcc-b774-812fc4e029ee", callId: "b173ca88-020d-4bcc-b774-812fc4e029ef" };
function fixture() {
  const config = shopcallAgentConfig();
  const profile = { agentId: "agent_test", name: SHOPCALL_AGENT_NAME, tags: [SHOPCALL_AGENT_TAG], conversationConfig: config.conversationConfig, platformSettings: { auth: { enableAuth: true }, privacy: { recordVoice: false } } };
  const calls = { create: 0, get: 0, sign: 0, authorized: 0 };
  const client: VoiceProvider = { conversationalAi: {
    agents: { create: async (_, options) => { assert.equal(options?.maxRetries, 0); calls.create++; return { agentId: "agent_test" }; }, get: async () => { calls.get++; return profile; } },
    conversations: { getSignedUrl: async input => { assert.equal(input.includeConversationId, true); calls.sign++; return { signedUrl: "wss://api.elevenlabs.io/v1/convai/conversation?conversation_signature=single-use-secret" }; } },
  } };
  return { profile, client, calls, authorization: { assertOwnerCall: async () => { calls.authorized++; } } };
}

test("voice tools match shared names and cannot apply or claim approval", () => {
  assert.deepEqual(shopcallClientTools.map(t => t.name).sort(), [...CLIENT_TOOL_NAMES].sort());
  assert.equal(shopcallAgentConfig().platformSettings?.auth?.enableAuth, true);
  assert.equal(shopcallAgentConfig().platformSettings?.privacy?.recordVoice, false);
  assert.throws(() => parseClientToolArgs("show_confirmation", { kind: "publish", proposalId: ids.callId, confirmed: true }));
  assert.throws(() => parseClientToolArgs("record_product_details", { productDraftId: ids.callId, priceMinor: 24.5 }));
  assert.throws(() => parseClientToolArgs("preview_catalog_changes", { changes: [{ type: "set_quantity", productId: "vase", newQuantity: 0 }] }));
  assert.equal(parseClientToolArgs("record_product_details", { productDraftId: ids.callId, quantityOnHand: 0 }).quantityOnHand, 0);
});

test("session issuance checks owner call before any provider access", async () => {
  const { client, calls } = fixture();
  await assert.rejects(issueVoiceSession(ids, { assertOwnerCall: async () => { throw new Error("private database credentials"); } }, { client, agentId: "agent_test" }), { code: "UNAUTHORIZED", message: "This owner cannot start a conversation for this call." });
  assert.deepEqual(calls, { create: 0, get: 0, sign: 0, authorized: 0 });
});

test("authorized owner receives only a single-use session credential", async () => {
  const { client, calls, authorization } = fixture();
  const session = await issueVoiceSession(ids, authorization, { client, agentId: "agent_test" });
  assert.deepEqual(Object.keys(session).sort(), ["callId", "connectionType", "signedUrl"]);
  assert.equal(session.connectionType, "websocket");
  assert.deepEqual(calls, { create: 0, get: 1, sign: 1, authorized: 1 });
});

test("public or misconfigured agent cannot issue session", async () => {
  const { client, profile, calls, authorization } = fixture();
  profile.platformSettings.auth.enableAuth = false;
  await assert.rejects(issueVoiceSession(ids, authorization, { client, agentId: "agent_test" }), { code: "CONFIG_MISMATCH" });
  assert.equal(calls.sign, 0);
});

test("provider errors and unexpected signed URL endpoints never leak credentials", async () => {
  const { client, authorization } = fixture();
  client.conversationalAi.conversations.getSignedUrl = async () => { throw new Error("xi-api-key: secret"); };
  await assert.rejects(issueVoiceSession(ids, authorization, { client, agentId: "agent_test" }), { code: "PROVIDER_ERROR", message: "Unable to issue a voice session. Retry from the authenticated call page." });
  client.conversationalAi.conversations.getSignedUrl = async () => ({ signedUrl: "wss://evil.example/?secret=abc" });
  await assert.rejects(issueVoiceSession(ids, authorization, { client, agentId: "agent_test" }), { code: "PROVIDER_ERROR" });
});

test("provisioning reuses persisted ID and verifies remote auth on rerun", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shopcall-agent-test-"));
  try {
    const { client, calls } = fixture();
    assert.equal((await provisionShopcallAgent({ client, stateDirectory: directory })).created, true);
    assert.equal((await provisionShopcallAgent({ client, stateDirectory: directory })).created, false);
    assert.equal(calls.create, 1);
    const state = JSON.parse(await readFile(join(directory, "elevenlabs-agent.json"), "utf8"));
    assert.deepEqual(state, { status: "created", agentId: "agent_test" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unknown create result is not automatically retried; explicit verified adoption recovers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shopcall-agent-test-"));
  try {
    const { client } = fixture();
    let attempts = 0;
    client.conversationalAi.agents.create = async () => { attempts++; throw new Error("network timeout with secret"); };
    await assert.rejects(provisionShopcallAgent({ client, stateDirectory: directory }), { code: "PROVIDER_ERROR" });
    await assert.rejects(provisionShopcallAgent({ client, stateDirectory: directory }), { code: "NOT_READY" });
    assert.equal(attempts, 1);
    assert.equal((await provisionShopcallAgent({ client, stateDirectory: directory, adoptAgentId: "agent_test" })).created, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("definite validation rejection allows corrected retry but only reports safe field paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shopcall-agent-test-"));
  try {
    const { client } = fixture();
    const create = client.conversationalAi.agents.create;
    client.conversationalAi.agents.create = async () => { throw new ElevenLabsError({ statusCode: 422, body: { detail: [{ loc: ["body", "conversation_config", "tts"], input: "secret-key", msg: "private-provider-body" }] } }); };
    await assert.rejects(provisionShopcallAgent({ client, stateDirectory: directory }), { code: "PROVIDER_ERROR", message: "ElevenLabs rejected agent creation (HTTP 422); invalid fields: body.conversation_config.tts. Check key scope, account access, and agent configuration." });
    client.conversationalAi.agents.create = create;
    assert.equal((await provisionShopcallAgent({ client, stateDirectory: directory })).created, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
