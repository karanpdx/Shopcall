// Test harness: real route handlers + real SQLite (in-memory) + real filesystem blob store. No provider mocks.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DATABASE_URL = ":memory:";
process.env.SESSION_SECRET = "test-secret-".padEnd(48, "x");
process.env.DEMO_OWNER_EMAIL = "owner@ceramics.example";
process.env.DEMO_OWNER_PASSWORD = "correct horse battery";
process.env.DEMO_BUSINESS_NAME = "Clay & Co";
process.env.PUBLIC_API_BASE = "https://api.shopcall.test";
process.env.ASSET_STORAGE_DIR = mkdtempSync(path.join(tmpdir(), "shopcall-assets-"));

export const ORIGIN = "http://localhost:3000";
let ip = 0;

export function call(method: string, urlPath: string, opts: { cookie?: string; body?: unknown; origin?: string | null; raw?: BodyInit } = {}) {
  const headers = new Headers();
  if (opts.cookie) headers.set("cookie", opts.cookie);
  if (opts.origin !== null && method !== "GET") headers.set("origin", opts.origin ?? ORIGIN);
  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(opts.body);
  }
  return new Request(ORIGIN + urlPath, { method, headers, body });
}

export const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

export async function body(res: Response) {
  return (await res.json()) as { ok: boolean; data?: any; error?: { code: string; message: string } };
}

/** Signs in as `email` (the demo-owner env var is switched to it, provisioning a separate business). */
export async function signIn(email = "owner@ceramics.example", businessName = "Clay & Co") {
  const { POST } = await import("../../src/app/api/auth/login/route");
  process.env.DEMO_OWNER_EMAIL = email;
  process.env.DEMO_BUSINESS_NAME = businessName;
  const req = call("POST", "/api/auth/login", { body: { email, password: process.env.DEMO_OWNER_PASSWORD } });
  req.headers.set("x-forwarded-for", `10.0.0.${++ip}`);
  const res = await POST(req);
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  return { cookie, session: (await body(res)).data };
}

export async function createAndApprove(cookie: string, change: unknown) {
  const drafts = await import("../../src/app/api/drafts/route");
  const approve = await import("../../src/app/api/drafts/[id]/approve/route");
  const created = await body(await drafts.POST(call("POST", "/api/drafts", { cookie, body: change })));
  if (!created.ok) throw new Error(`draft failed: ${JSON.stringify(created)}`);
  const res = await approve.POST(call("POST", `/api/drafts/${created.data.id}/approve`, { cookie }), params({ id: created.data.id }));
  return { status: res.status, ...(await body(res)), draftId: created.data.id as string };
}

export const bracelet = { name: "Beaded bracelet", description: "Hand-strung glass beads", category: "Jewelry", priceCents: 2500, inventoryCount: 10 };
