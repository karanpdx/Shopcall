import { requireOwner, type Owner } from "../../server/auth";
import { fail } from "../../server/http";

/** B supplies cookie/session auth. New voice mutations also require a browser Origin. */
export function requireWorkspaceOwner(req: Request): Owner {
  const owner = requireOwner(req);
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    const trustedOrigin = process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).origin : new URL(req.url).origin;
    if (!origin || origin !== trustedOrigin || req.headers.get("sec-fetch-site") === "cross-site") fail(403, "FORBIDDEN", "Same-origin browser request required.");
  }
  return owner;
}

/** Tool arguments contain text/IDs, never image bytes. Bound even chunked bodies. */
export async function readWorkspaceJson(req: Request): Promise<unknown> {
  const max = 64 * 1024;
  if (Number(req.headers.get("content-length")) > max) fail(413, "PAYLOAD_TOO_LARGE", "Call request exceeds 64 KiB.");
  const reader = req.body?.getReader();
  if (!reader) return fail(400, "INVALID_INPUT", "JSON request body required.");
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return fail(413, "PAYLOAD_TOO_LARGE", "Call request exceeds 64 KiB."); }
    chunks.push(value);
  }
  const buffer = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(buffer)); }
  catch { return fail(400, "INVALID_INPUT", "Request body must be valid JSON."); }
}
