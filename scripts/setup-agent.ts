import { provisionShopcallAgent, VoiceIntegrationError } from "../src/integrations/elevenlabs/service";

const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === "--adopt" && args[1])) {
  console.error("Usage: npm run agent:setup [-- --adopt <existing-shopcall-agent-id>]");
  process.exit(1);
}
try {
  const result = await provisionShopcallAgent({ adoptAgentId: args[1] });
  console.log(JSON.stringify({ ...result, dashboardUrl: `https://elevenlabs.io/app/agents/agents/${result.agentId}`, conversationTested: false }));
} catch (error) {
  console.error(error instanceof VoiceIntegrationError ? `${error.code}: ${error.message}` : "Agent setup failed. Check local storage permissions and provider configuration.");
  process.exitCode = 1;
}
