import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ElevenLabs } from "@elevenlabs/elevenlabs-js";
import { ElevenLabsError } from "@elevenlabs/elevenlabs-js";
import { createElevenLabsClient } from "./client";
import { shopcallAgentConfig, SHOPCALL_AGENT_NAME, SHOPCALL_AGENT_TAG } from "./config";
import { shopcallClientTools } from "./tools";

export class VoiceIntegrationError extends Error {
  constructor(public readonly code: "UNAUTHORIZED" | "NOT_READY" | "PROVIDER_ERROR" | "CONFIG_MISMATCH", message: string) { super(message); this.name = "VoiceIntegrationError"; }
}

type AgentProfile = Pick<ElevenLabs.GetAgentResponseModel, "agentId" | "name" | "tags" | "platformSettings" | "conversationConfig">;
export interface VoiceProvider {
  conversationalAi: {
    agents: {
      create(config: ReturnType<typeof shopcallAgentConfig>, options?: { maxRetries?: number }): Promise<{ agentId: string }>;
      get(agentId: string): Promise<AgentProfile>;
    };
    conversations: {
      getSignedUrl(input: { agentId: string; includeConversationId: boolean }): Promise<{ signedUrl: string }>;
    };
  };
}

/** Never accept this from request JSON. Backend derives owner identity from session. */
export type VoiceCallContext = { ownerUserId: string; businessId: string; callId: string };
export interface VoiceAuthorization {
  /** Must reject if owner/session/business/call does not match or call already ended. */
  assertOwnerCall(context: VoiceCallContext): Promise<void>;
}
const callContext = z.object({ ownerUserId: z.uuid(), businessId: z.uuid(), callId: z.uuid() }).strict();
const agentState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("creating"), startedAt: z.string() }).strict(),
  z.object({ status: z.literal("created"), agentId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("rejected"), httpStatus: z.number().int() }).strict(),
]);
type AgentState = z.infer<typeof agentState>;

export function assertManagedPrivateAgent(agent: AgentProfile): void {
  const tools = agent.conversationConfig.agent?.prompt?.tools ?? [];
  const names = tools.map(t => "name" in t ? t.name : "").sort();
  const expected = shopcallClientTools.map(t => t.name).sort();
  if (agent.name !== SHOPCALL_AGENT_NAME || !agent.tags?.includes(SHOPCALL_AGENT_TAG)
    || agent.platformSettings?.auth?.enableAuth !== true
    || agent.platformSettings?.privacy?.recordVoice !== false
    || JSON.stringify(names) !== JSON.stringify(expected)
    || tools.some(t => t.type !== "client")) {
    throw new VoiceIntegrationError("CONFIG_MISMATCH", "Agent must be the dedicated authenticated Shopcall agent with the expected tool set and recording disabled.");
  }
}

async function verifyAgent(client: VoiceProvider, agentId: string): Promise<void> {
  let agent: AgentProfile;
  try { agent = await client.conversationalAi.agents.get(agentId); }
  catch { throw new VoiceIntegrationError("PROVIDER_ERROR", "Unable to verify the ElevenLabs agent. Check account access and retry."); }
  assertManagedPrivateAgent(agent);
}

function statePaths(directory = ".shopcall") {
  const dir = resolve(directory);
  return { dir, file: join(dir, "elevenlabs-agent.json"), lock: join(dir, "elevenlabs-agent.lock") };
}
async function readState(file: string): Promise<AgentState | undefined> {
  try { return agentState.parse(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new VoiceIntegrationError("NOT_READY", "Local ElevenLabs agent state is invalid; reconcile it before provisioning.");
  }
}
async function persistState(file: string, state: AgentState) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, file);
}

export async function getConfiguredAgentId(stateDirectory?: string): Promise<string> {
  const configured = process.env.ELEVENLABS_AGENT_ID?.trim();
  if (configured) return configured;
  const state = await readState(statePaths(stateDirectory).file);
  if (state?.status === "created") return state.agentId;
  throw new VoiceIntegrationError("NOT_READY", "No verified Shopcall agent is configured. Run npm run agent:setup.");
}

/** One-at-a-time, crash-aware provisioning. Unknown create outcomes never trigger an automatic second create. */
export async function provisionShopcallAgent(options: { client?: VoiceProvider; stateDirectory?: string; adoptAgentId?: string } = {}) {
  const client = options.client ?? createElevenLabsClient();
  const paths = statePaths(options.stateDirectory);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  try { await mkdir(paths.lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new VoiceIntegrationError("NOT_READY", "Agent provisioning is locked. If a process crashed, reconcile its outcome before removing the lock directory.");
    throw error;
  }
  try {
    const state = await readState(paths.file);
    const knownId = options.adoptAgentId?.trim() || process.env.ELEVENLABS_AGENT_ID?.trim() || (state?.status === "created" ? state.agentId : undefined);
    if (knownId) {
      await verifyAgent(client, knownId);
      await persistState(paths.file, { status: "created", agentId: knownId });
      return { agentId: knownId, created: false, authenticated: true as const };
    }
    if (state?.status === "creating") throw new VoiceIntegrationError("NOT_READY", "A prior agent creation has an unknown outcome. Find the dedicated Shopcall agent in ElevenLabs and rerun with --adopt <agent-id>; do not blindly retry creation.");
    await persistState(paths.file, { status: "creating", startedAt: new Date().toISOString() });
    let result: { agentId: string };
    try { result = await client.conversationalAi.agents.create(shopcallAgentConfig(), { maxRetries: 0 }); }
    catch (error) {
      // Only definite client-side HTTP rejection is retryable. Never include provider body,
      // request headers, SDK error.message, or schema input values in logs/errors.
      const status = error instanceof ElevenLabsError ? error.statusCode : undefined;
      if (status && [400, 401, 403, 404, 422].includes(status)) {
        await persistState(paths.file, { status: "rejected", httpStatus: status });
        const validationPaths = safeValidationPaths(error instanceof ElevenLabsError ? error.body : undefined);
        throw new VoiceIntegrationError("PROVIDER_ERROR", `ElevenLabs rejected agent creation (HTTP ${status})${validationPaths ? `; invalid fields: ${validationPaths}` : ""}. Check key scope, account access, and agent configuration.`);
      }
      throw new VoiceIntegrationError("PROVIDER_ERROR", "Agent creation did not return a confirmed result. Reconcile in ElevenLabs before retrying; no second agent was requested.");
    }
    if (!result.agentId) throw new VoiceIntegrationError("PROVIDER_ERROR", "Agent creation returned no identifier. Reconcile the remote outcome before retrying.");
    await persistState(paths.file, { status: "created", agentId: result.agentId });
    await verifyAgent(client, result.agentId);
    return { agentId: result.agentId, created: true, authenticated: true as const };
  } finally { await rm(paths.lock, { recursive: true, force: true }); }
}

function safeValidationPaths(body: unknown): string {
  if (!body || typeof body !== "object" || !("detail" in body) || !Array.isArray(body.detail)) return "";
  return body.detail.slice(0, 12).flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("loc" in entry) || !Array.isArray(entry.loc)) return [];
    const path = entry.loc.filter((part: unknown) => (typeof part === "string" || typeof part === "number") && /^[a-zA-Z0-9_-]+$/.test(String(part))).join(".");
    return path ? [path] : [];
  }).join(", ");
}

/** B's route must additionally enforce same-origin/CSRF, session expiry and rate limits. */
export async function issueVoiceSession(context: VoiceCallContext, authorization: VoiceAuthorization, options: { client?: VoiceProvider; agentId?: string; stateDirectory?: string } = {}) {
  const parsed = callContext.safeParse(context);
  if (!parsed.success) throw new VoiceIntegrationError("UNAUTHORIZED", "A valid authenticated owner call is required.");
  try { await authorization.assertOwnerCall(parsed.data); }
  catch { throw new VoiceIntegrationError("UNAUTHORIZED", "This owner cannot start a conversation for this call."); }
  const client = options.client ?? createElevenLabsClient();
  const agentId = options.agentId ?? await getConfiguredAgentId(options.stateDirectory);
  await verifyAgent(client, agentId);
  let signedUrl: string;
  try { ({ signedUrl } = await client.conversationalAi.conversations.getSignedUrl({ agentId, includeConversationId: true })); }
  catch { throw new VoiceIntegrationError("PROVIDER_ERROR", "Unable to issue a voice session. Retry from the authenticated call page."); }
  let url: URL;
  try { url = new URL(signedUrl); } catch { throw new VoiceIntegrationError("PROVIDER_ERROR", "Voice provider returned an invalid session credential."); }
  if (url.protocol !== "wss:" || url.hostname !== "api.elevenlabs.io" || url.username || url.password
    || url.pathname !== "/v1/convai/conversation" || !url.searchParams.get("conversation_signature")) {
    throw new VoiceIntegrationError("PROVIDER_ERROR", "Voice provider returned an unexpected session endpoint.");
  }
  // Return only to the authenticated browser, with Cache-Control: no-store. Never log this object.
  return { signedUrl, connectionType: "websocket" as const, callId: context.callId };
}
