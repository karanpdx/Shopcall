import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { localReplitConnection } from "../src/integrations/replit/local";
import { ReplitMcpClient } from "../src/integrations/replit/client";

// Provider diagnostic only. Synthetic data; not a storefront acceptance demonstration.
const action = process.argv[2];
if (!["create", "inspect", "publish", "status", "verify"].includes(action)) throw new Error("Usage: replit:probe -- create|inspect|publish|status|verify");
const { store, service, directory } = localReplitConnection();
const file = join(directory, "replit-probe.json");
type Probe = { state: string; replId?: string; turnId?: string; replUrl?: string; publicUrl?: string; requestedAt: string; verifiedAt?: string };
let state: Probe | undefined;
try { state = JSON.parse(await readFile(file, "utf8")) as Probe; }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid probe state; reconcile before proceeding."); }
async function persist(next: Probe) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await rename(temp, file);
  state = next;
}
const createdSchema = z.object({ replId: z.uuid(), turnId: z.string(), phase: z.enum(["creating", "failed"]), replUrl: z.url() });
let client: ReplitMcpClient | undefined;
try {
  client = await ReplitMcpClient.connect(service.provider(process.env.DEMO_OWNER_ID ?? "shopcall-local-demo-owner"));
  await client.discoverTools();
  if (action === "create") {
    if (state) throw new Error("Probe already requested. Inspect/reconcile existing app instead of creating another.");
    await persist({ state: "creating", requestedAt: new Date().toISOString() });
    const raw = await client.createApp({
      app_stack: "react_website",
      appDescription: "Build a tiny synthetic integration probe web app for Shopcall's backend integration test. It is not a real merchant storefront. Visibly show 'Shopcall integration probe', 'Synthetic integration test — not a merchant storefront', and the exact marker shopcall-probe-20261120. Give it a simple accessible mobile-friendly page. Add a read-only GET /api/probe endpoint returning JSON with kind shopcall-probe-20261120 and a fresh serverTime timestamp. Set Cache-Control: no-store for the page and endpoint. No login, email, payments, merchant inventory, third-party services, or secrets are needed. Build and run the preview; the external controller will publish separately after it verifies output. Keep this probe minimal.",
    });
    const created = createdSchema.parse(raw.structuredContent);
    await persist({ ...state!, state: created.phase, replId: created.replId, replUrl: created.replUrl, turnId: created.turnId });
    console.log(JSON.stringify({ phase: created.phase, replId: created.replId, editorUrl: created.replUrl }));
  } else {
    if (!state?.replId) throw new Error("No confirmed probe app ID; reconcile create outcome first.");
    if (action === "inspect") {
      const files = await client.listAppFiles(state.replId);
      const value = files.structuredContent;
      // Artifact listing contains paths, not file bodies or credentials.
      console.log(JSON.stringify({ replId: state.replId, listing: value }));
    }
    if (action === "publish") {
      if (state.state === "publish-requested" || state.state === "verified") throw new Error("Publication already requested; use status or verify.");
      await persist({ ...state, state: "publish-requested" });
      const result = await client.publishApp(state.replId);
      const response = z.object({ deploymentId: z.string(), status: z.string() }).parse(result.structuredContent);
      console.log(JSON.stringify(response));
    }
    if (action === "status") {
      const result = await client.getPublishStatus(state.replId);
      const response = z.object({ found: z.boolean(), status: z.string().optional(), url: z.url().optional() }).parse(result.structuredContent);
      if (response.found && response.status === "success" && response.url) await persist({ ...state, publicUrl: response.url });
      console.log(JSON.stringify(response));
    }
    if (action === "verify") {
      if (!state.publicUrl) throw new Error("No provider-confirmed public URL.");
      const url = new URL(state.publicUrl);
      if (url.protocol !== "https:" || !url.hostname.endsWith(".replit.app") || url.username || url.password || url.search || url.hash) throw new Error("Unexpected probe deployment origin.");
      const page = await fetch(url, { credentials: "omit", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(20_000) });
      const html = await page.text();
      if (!page.ok || !html.includes("shopcall-probe-20261120")) throw new Error("Anonymous probe page marker missing.");
      const check = await fetch(new URL("/api/probe", url), { credentials: "omit", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(20_000) });
      const data = z.object({ kind: z.literal("shopcall-probe-20261120"), serverTime: z.string() }).parse(await check.json());
      if (!check.ok) throw new Error("Probe endpoint failed.");
      await persist({ ...state, state: "verified", verifiedAt: new Date().toISOString() });
      console.log(JSON.stringify({ verified: true, publicUrl: url.href, kind: data.kind, syntheticProbeOnly: true }));
    }
  }
} catch (error) {
  // Never print raw provider errors, auth headers or tokens.
  console.error(error instanceof z.ZodError ? "Probe provider output differs from observed tool schema. Inspect safe metadata and reconcile existing app." : error instanceof Error && /^(?:Probe already|No confirmed|Publication already|No provider-confirmed|Unexpected probe|Anonymous probe|Probe endpoint)/.test(error.message) ? error.message : "Probe action failed; inspect persisted state and reconcile remote outcome before retrying mutations.");
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  store.close();
}
