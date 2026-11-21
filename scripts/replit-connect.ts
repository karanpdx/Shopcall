import { createServer } from "node:http";
import { localReplitConnection } from "../src/integrations/replit/local";

const ownerId = process.env.DEMO_OWNER_ID ?? "shopcall-local-demo-owner";
const { store, service } = localReplitConnection();
const callback = new URL(service.callbackUrl);
// Local helper never listens on public interfaces or serves arbitrary redirects.
if (callback.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(callback.hostname) || !callback.port) {
  store.close();
  throw new Error("CLI OAuth requires an explicit HTTP loopback callback port. Deploy callback routes separately for HTTPS hosting.");
}

let complete!: () => void;
let fail!: (error: Error) => void;
const finished = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
const server = createServer(async (req, res) => {
  const incoming = new URL(req.url ?? "/", callback.origin);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" || incoming.pathname !== callback.pathname || req.headers.host !== callback.host) {
    res.writeHead(404).end("Not found."); return;
  }
  try {
    if (incoming.searchParams.has("error")) throw new Error("Authorization denied.");
    await service.complete(ownerId, incoming.searchParams.get("state") ?? "", incoming.searchParams.get("code") ?? "");
    res.writeHead(200).end("Shopcall connected to Replit. You may close this window.");
    complete();
  } catch {
    res.writeHead(400).end("Replit authorization failed or callback expired. Restart connection from terminal.");
    // Invalid state does not terminate a legitimate pending flow.
  }
});
const timer = setTimeout(() => fail(new Error("Replit authorization timed out. Restart connection.")), 10 * 60_000);
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(callback.port), callback.hostname, resolve);
  });
  const result = await service.begin(ownerId);
  if (result.state === "connected") {
    console.log("Shopcall's Replit OAuth connection is already authorized.");
  } else {
    console.log("Open this Replit authorization URL, sign in, select the workspace, and approve Shopcall:");
    console.log(result.authorizationUrl);
    await finished;
    console.log("Replit OAuth connected. Run replit:check to discover actual tools.");
  }
} catch {
  console.error("Replit OAuth connection failed, timed out, or local callback port is unavailable. No app was created.");
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
}
