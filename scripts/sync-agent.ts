import { createElevenLabsClient } from "../src/integrations/elevenlabs/client";
import { getConfiguredAgentId, assertManagedPrivateAgent } from "../src/integrations/elevenlabs/service";
import { shopcallAgentConfig } from "../src/integrations/elevenlabs/config";

try {
  const client = createElevenLabsClient();
  const agentId = await getConfiguredAgentId();
  assertManagedPrivateAgent(await client.conversationalAi.agents.get(agentId));
  await client.conversationalAi.agents.update(agentId, shopcallAgentConfig());
  const updated = await client.conversationalAi.agents.get(agentId);
  assertManagedPrivateAgent(updated);
  if (updated.conversationConfig.agent?.prompt?.prompt !== shopcallAgentConfig().conversationConfig?.agent?.prompt?.prompt) throw new Error("Policy read-back differs.");
  console.log(JSON.stringify({ updated: true, authenticated: true, conciseIntakePolicyVerified: true, conversationTested: false }));
} catch {
  console.error("Managed agent policy sync failed; no conversation was started. Verify dedicated agent access and retry.");
  process.exitCode = 1;
}
