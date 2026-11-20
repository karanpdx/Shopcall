import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import type { PublicationWorkflow } from "../src/integrations/publication/workflow";
import type { PublicationNotificationWorker } from "../src/integrations/publication/notifications";

// The runtime factory is local deployment configuration, never a merchant/tool input.
// B supplies production auth/approval/run-store adapters. One tick is safe for queue scheduling.
const args = process.argv.slice(2);
const runId = args[0] === "--run" ? args[1] : undefined;
if (!runId || !z.uuid().safeParse(runId).success || args.length !== 2 || !process.env.SHOPCALL_RUNTIME_MODULE) {
  console.error("Usage: npm run worker -- --run <uuid>. Configure SHOPCALL_RUNTIME_MODULE exporting createPublicationRuntime(); see publication-handoff.md.");
  process.exitCode = 1;
} else {
  try {
    const configured = resolve(process.env.SHOPCALL_RUNTIME_MODULE);
    const runtime = await import(pathToFileURL(configured).href) as {
      createPublicationRuntime(): Promise<{ workflow: PublicationWorkflow; notifications?: PublicationNotificationWorker; close?: () => Promise<void> }>;
    };
    const { workflow, notifications, close } = await runtime.createPublicationRuntime();
    try {
      const run = await workflow.step(runId);
      // Never log owner/approval details, provider payloads, session URLs, or OAuth secrets.
      console.log(JSON.stringify({ runId: run.id, phase: run.phase, task: run.currentTaskId, errorCode: run.errorCode }));
      if (run.phase === "ready") {
        if (notifications) {
          try { console.log(JSON.stringify({ runId: run.id, notification: await notifications.step(run.id) })); }
          catch { console.error("Verified storefront is ready, but notification processing failed. Retry notification worker without rebuilding."); process.exitCode = 1; }
        } else console.log(JSON.stringify({ runId: run.id, notification: "not_configured" }));
      }
      if (run.phase === "blocked" || run.phase === "failed") process.exitCode = 1;
    } finally { await close?.(); }
  } catch {
    console.error("Publication worker could not execute this run. Check configured runtime adapters and persisted state.");
    process.exitCode = 1;
  }
}
