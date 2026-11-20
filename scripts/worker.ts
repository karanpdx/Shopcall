import { z } from "zod";
import { setTimeout as pause } from "node:timers/promises";
import { createBackendRuntime } from "../src/integrations/backend/runtime";

const args = process.argv.slice(2);
const mode = args[0] ?? "--once";
if (!(["--once", "--loop"].includes(mode) && args.length <= 1 || mode === "--run" && args.length === 2 && z.uuid().safeParse(args[1]).success)) {
  console.error("Usage: npm run worker -- --once | --run <job-uuid> | --loop");
  process.exitCode = 1;
} else {
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  try {
    const runtime = createBackendRuntime();
    try {
      do {
        const result = await runtime.tick(mode === "--run" ? { runId: args[1] } : {});
        // Status projection only: no raw provider bodies, OAuth/session URLs or emails.
        console.log(JSON.stringify(result));
        if (mode !== "--loop") { if (["blocked", "failed", "not_found"].includes(result.phase)) process.exitCode = 1; break; }
        if (!stopping) await pause(5000);
      } while (!stopping);
    } finally { await runtime.close(); }
  } catch {
    console.error("Backend worker could not initialize. Check database, public backend URL, Replit OAuth/profile, Chrome and durable storage configuration.");
    process.exitCode = 1;
  }
}
