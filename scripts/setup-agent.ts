import { createElevenLabsClient } from "../src/integrations/elevenlabs/client";

// Read-only connection check. Actual agent provisioning belongs to Person C.
const client = createElevenLabsClient();
try {
  const response = await client.conversationalAi.agents.list({ pageSize: 1 });
  console.log(JSON.stringify({ connected: true, visibleAgents: response.agents.length }));
} catch {
  console.error("ElevenLabs connection check failed. Verify key scope and account access.");
  process.exitCode = 1;
}
