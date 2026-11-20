import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { getConfiguredAgentId } from "../src/integrations/elevenlabs/service";

// Reads configured values via process.env only; never reads or prints .env.local.
const defaults: Record<string, string> = {
  APP_BASE_URL: "http://localhost:3000",
  PUBLIC_API_BASE: "http://localhost:3000",
  DATABASE_URL: ".shopcall/demo.sqlite",
  ASSET_STORAGE_DIR: ".shopcall/assets",
  SESSION_SECRET: randomBytes(32).toString("base64"),
  DEMO_OWNER_EMAIL: "merchant@shopcall.example",
  DEMO_OWNER_PASSWORD: randomBytes(18).toString("base64url"),
  DEMO_BUSINESS_NAME: "Your studio",
};
try { defaults.ELEVENLABS_AGENT_ID = await getConfiguredAgentId(); } catch { /* Onboard/provision separately; no invented agent ID. */ }
await mkdir(".shopcall", { recursive: true, mode: 0o700 });
const missing = Object.entries(defaults).filter(([name]) => !process.env[name]?.trim());
if (missing.length) await appendFile(".env.local", `\n# Local fixed-merchant demo defaults\n${missing.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n")}\n`, { mode: 0o600 });
// Credentials go only to a private ignored local file the user can open, never tool output.
if (missing.some(([name]) => name === "DEMO_OWNER_PASSWORD")) {
  await writeFile(".shopcall/demo-login.txt", `Shopcall local demo\n\nOpen: http://localhost:3000\nEmail: ${process.env.DEMO_OWNER_EMAIL || defaults.DEMO_OWNER_EMAIL}\nPassword: ${defaults.DEMO_OWNER_PASSWORD}\n\nFixed demo account only. No real notification email is configured by this script.\n`, { mode: 0o600 });
}
console.log(JSON.stringify({ configured: missing.map(([name]) => name), loginFile: resolve(".shopcall/demo-login.txt"), voiceAgentConfigured: Boolean(process.env.ELEVENLABS_AGENT_ID || defaults.ELEVENLABS_AGENT_ID), publicDeploymentConfigured: false }));
