import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

const catalogPath = /^\/api\/public\/[a-z0-9]+(?:-[a-z0-9]+)*\/catalog$/;
const assetPath = /^\/api\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const imageType = /^image\/(?:jpeg|png|webp|avif)(?:;|$)/i;
const MAX_BODY = 20_000_000;

/** The target is fixed localhost; no request data can choose host, port, or protocol. */
export function createPublicCatalogProxy(request: typeof fetch = fetch) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "";
    const isCatalog = path.length <= 160 && catalogPath.test(path);
    const isAsset = assetPath.test(path);
    const baseHeaders = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    };
    const fail = (status: number, text: string) => {
      res.writeHead(status, { ...baseHeaders, "content-type": "text/plain; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : text);
    };
    if (!["GET", "HEAD"].includes(req.method ?? "") || (!isCatalog && !isAsset)) {
      fail(404, "Not found."); return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15_000);
    res.once("close", () => { if (!res.writableEnded) abort.abort(); });
    try {
      // No cookies, Authorization, Host, Origin, forwarded headers, or caller-supplied URL.
      const upstream = await request(`http://127.0.0.1:3000${path}`, {
        method: req.method,
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal: abort.signal,
        headers: { Accept: isCatalog ? "application/json" : "image/jpeg,image/png,image/webp,image/avif" },
      });
      if (upstream.status !== 200) {
        await upstream.body?.cancel();
        fail(upstream.status === 404 ? 404 : 502, upstream.status === 404 ? "Not found." : "Public data unavailable."); return;
      }
      const contentType = upstream.headers.get("content-type") ?? "";
      if (isCatalog ? !/^application\/json(?:;|$)/i.test(contentType) : !imageType.test(contentType)) {
        await upstream.body?.cancel(); fail(502, "Public data unavailable."); return;
      }
      const responseHeaders: Record<string, string> = { ...baseHeaders, "content-type": contentType };
      if (isAsset) {
        const cache = upstream.headers.get("cache-control");
        if (cache && !/private/i.test(cache)) responseHeaders["cache-control"] = cache;
        const etag = upstream.headers.get("etag");
        if (etag) responseHeaders.etag = etag;
      }
      if (req.method === "HEAD") {
        await upstream.body?.cancel();
        res.writeHead(200, responseHeaders).end(); return;
      }
      const reader = upstream.body?.getReader();
      if (!reader) { fail(502, "Public data unavailable."); return; }
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > (isCatalog ? 2_000_000 : MAX_BODY)) throw new Error("PUBLIC_RESPONSE_LIMIT");
          chunks.push(next.value);
        }
      } finally { await reader.cancel(); }
      const bytes = Buffer.concat(chunks);
      res.writeHead(200, { ...responseHeaders, "content-length": bytes.length });
      res.end(bytes);
    } catch {
      if (!res.headersSent) fail(502, "Public data unavailable.");
      else res.destroy();
    } finally { clearTimeout(timer); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createPublicCatalogProxy();
  server.listen(8789, "127.0.0.1", () => console.log("Read-only public catalog proxy listening on http://127.0.0.1:8789"));
  server.on("error", () => { console.error("Public catalog proxy could not listen on loopback port 8789."); process.exitCode = 1; });
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
