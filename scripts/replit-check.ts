import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { localReplitConnection } from "../src/integrations/replit/local";
import { ReplitMcpClient } from "../src/integrations/replit/client";

const ownerId = process.env.DEMO_OWNER_ID ?? "shopcall-local-demo-owner";
const { store, service, directory } = localReplitConnection();
let client: ReplitMcpClient | undefined;
try {
  client = await ReplitMcpClient.connect(service.provider(ownerId));
  const tools = await client.discoverTools();
  // Schemas and tool names only. Never persist raw auth headers or credentials.
  writeFileSync(resolve(directory, "replit-tools.json"), JSON.stringify({ discoveredAt: new Date().toISOString(), tools: tools.map(({ name, inputSchema, outputSchema }) => ({ name, inputSchema, outputSchema })) }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ connected: true, tools: tools.map(tool => tool.name), schemasFile: ".shopcall/replit-tools.json" }));
} catch {
  console.error("Replit tool discovery failed. Run the project OAuth connection command; Codex authentication does not configure this backend.");
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  store.close();
}
