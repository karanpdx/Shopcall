import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { getDb } from "../../server/db";
import { repository } from "../../server/repository";
import { SqliteBackendJobSource } from "./source";
import { BackendConfigurationError, BackendQueueRuntime } from "./queue";
import { FileBuildRunStore } from "../publication/store";
import { composePublicationRuntime } from "../publication/runtime";
import { ReplitMcpClient } from "../replit/client";
import { responseProfileSchema } from "../replit/results";
import { loadNotificationConfig, getNotificationHealth, getPublicationNotificationStatus, createResendClient } from "../notifications";
import { WorkflowPublicationSource, PublicationNotificationWorker } from "../publication/notifications";
import { SqliteNotificationOutbox } from "../notifications/outbox-sqlite";
import { runtimeReplitOwner, webReplitConnection } from "./replit-web";
import { toOwnerBuildStatus } from "../publication/status";

export function createBackendRuntime() {
  const source = new SqliteBackendJobSource(getDb(), repository());
  const runs = new FileBuildRunStore();
  const queue = new BackendQueueRuntime(source, runs, async ownerId => {
    let profile: ReturnType<typeof responseProfileSchema.parse>;
    try { profile = responseProfileSchema.parse(JSON.parse(await readFile(resolve(process.env.REPLIT_RESPONSE_PROFILE_PATH || ".shopcall/replit-response-profile.json"), "utf8"))); }
    catch { throw new BackendConfigurationError("REPLIT_RESPONSE_PROFILE_REQUIRED"); }
    const chrome = process.env.CHROME_EXECUTABLE_PATH;
    if (!chrome) throw new BackendConfigurationError("CHROME_EXECUTABLE_PATH_REQUIRED");
    try { await access(chrome); } catch { throw new BackendConfigurationError("CHROME_EXECUTABLE_UNAVAILABLE"); }
    let backendOrigin: string;
    try {
      const api = new URL(process.env.PUBLIC_API_BASE || "");
      if (api.protocol !== "https:" || api.username || api.password || api.search || api.hash || api.hostname === "localhost" || api.hostname.endsWith(".test")) throw new Error();
      backendOrigin = api.origin;
    } catch { throw new BackendConfigurationError("PUBLIC_HTTPS_BACKEND_REQUIRED"); }
    const business = getDb().prepare("SELECT id FROM businesses WHERE owner_id=?").get(ownerId) as { id: string } | undefined;
    const identity = await source.getVerifiedOwnerEmail(ownerId, business?.id || "");
    const connectionOwner = runtimeReplitOwner(ownerId, !!identity);
    const oauth = webReplitConnection();
    let client: ReplitMcpClient | undefined; let outbox: SqliteNotificationOutbox | undefined;
    try {
      if (!(await oauth.store.getConnection(connectionOwner)).tokens) throw new BackendConfigurationError("REPLIT_OWNER_CONNECTION_REQUIRED");
      client = await ReplitMcpClient.connect(oauth.service.provider(connectionOwner));
      await client.discoverTools();
      const notification = (() => {
        if (!getNotificationHealth().configured) return undefined;
        try { return { config: loadNotificationConfig(), outbox: (outbox = new SqliteNotificationOutbox()) }; }
        catch { outbox?.close(); outbox = undefined; return undefined; }
      })();
      return composePublicationRuntime({ runs, authorization: source, owners: source, replit: client, responseProfile: profile,
        trustedOrigins: [backendOrigin, ...configuredStorageOrigins()],
        launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true, chromiumSandbox: true, timeout: 20_000 }),
        notification, closeStorage: async () => { outbox?.close(); oauth.store.close(); },
      });
    } catch (error) { await client?.close().catch(() => {}); outbox?.close(); oauth.store.close(); throw error; }
  });
  return {
    async tick(options: { runId?: string } = {}) {
      const result = await queue.tick(options);
      if (result.phase !== "idle") return result;
      if (!getNotificationHealth().configured) return { ...result, notification: "not_configured" };
      // Continue send retries/delivery polling after B's build row became terminal.
      // No Replit session or second build is needed for notification maintenance.
      const outbox = new SqliteNotificationOutbox();
      try {
        const rows = getDb().prepare("SELECT id FROM build_jobs WHERE publication_status='completed' ORDER BY updated_at DESC LIMIT 25").all() as { id: string }[];
        for (const row of rows) {
          const status = await getPublicationNotificationStatus(outbox, row.id);
          if (["none", "pending", "accepted"].includes(status.status)) {
            const config = loadNotificationConfig();
            const worker = new PublicationNotificationWorker({ outbox, publications: new WorkflowPublicationSource(runs, source), sender: { from: config.from, replyTo: config.replyTo }, resend: createResendClient({ apiKey: config.resendApiKey, baseUrl: config.resendBaseUrl }) });
            return { ...result, notification: await worker.step(row.id) };
          }
        }
        return result;
      } catch { return { ...result, notification: { code: "NOTIFICATION_PROCESSING_FAILED" } }; }
      finally { outbox.close(); }
    },
    async close() {},
  };
}
function configuredStorageOrigins(): string[] {
  const value = process.env.S3_PUBLIC_BASE_URL;
  if (!value) return [];
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new BackendConfigurationError("PUBLIC_STORAGE_ORIGIN_INVALID");
  return [url.origin];
}
/** B GET route passes cookie-derived owner; never serialize full private run/state. */
export async function getBackendBuildStatus(owner: { ownerId: string; businessId: string }, jobId: string) {
  const source = new SqliteBackendJobSource(getDb(), repository());
  const job = await source.assertOwnerJob(owner.ownerId, owner.businessId, jobId);
  const run = await new FileBuildRunStore().load(jobId);
  if (run && (run.approval.ownerUserId !== owner.ownerId || run.approval.businessId !== owner.businessId)) throw new BackendConfigurationError("RUN_OWNERSHIP_MISMATCH");
  let notification: unknown = { status: "not_configured" };
  if (getNotificationHealth().configured) {
    let outbox: SqliteNotificationOutbox | undefined;
    try { loadNotificationConfig(); outbox = new SqliteNotificationOutbox(); notification = await getPublicationNotificationStatus(outbox, jobId); }
    catch { notification = { status: "configuration_error" }; }
    finally { outbox?.close(); }
  }
  return { ...job, workflow: run ? toOwnerBuildStatus(run) : null, notification };
}
