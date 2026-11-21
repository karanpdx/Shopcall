import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { loginInput, type Session } from "@/contracts/api";
import { fail } from "./http";
import { repository } from "./repository";

export const SESSION_COOKIE = "shopcall_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) return fail(503, "CONFIGURATION_ERROR", "SESSION_SECRET must be set (at least 32 characters).");
  return s;
}

const hashToken = (token: string) => createHmac("sha256", sessionSecret()).update(token).digest("hex");
const digest = (s: string) => createHash("sha256").update(s).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

// shortcut: per-process memory; resets on restart and isn't shared across instances. Move to the DB if scaled out.
const attempts = new Map<string, { count: number; resetAt: number }>();
function rateLimit(key: string) {
  const t = Date.now();
  const a = attempts.get(key);
  if (!a || a.resetAt < t) attempts.set(key, { count: 1, resetAt: t + 15 * 60 * 1000 });
  else if (++a.count > 10) fail(429, "RATE_LIMITED", "Too many login attempts. Try again later.");
}

function cookieHeader(value: string, maxAgeSeconds: number) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function readCookie(req: Request) {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return v.join("=");
  }
  return null;
}

/** Rejects cross-site state-changing requests (CSRF). Browsers always send Origin on cross-origin POSTs. */
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const allowed = new Set([new URL(req.url).origin]);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) allowed.add(`${req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "")}://${host}`);
  if (process.env.APP_BASE_URL) allowed.add(new URL(process.env.APP_BASE_URL).origin);
  if (process.env.PHONE_DEMO_ORIGIN) allowed.add(new URL(process.env.PHONE_DEMO_ORIGIN).origin);
  if (!allowed.has(origin)) fail(403, "FORBIDDEN", "Cross-origin request rejected.");
}

/** Validates demo credentials, provisions the demo owner/business, and returns the session plus Set-Cookie header. */
export async function login(req: Request, body: unknown) {
  assertSameOrigin(req);
  rateLimit(req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local");
  const { email, password } = loginInput.parse(body);
  const demoEmail = process.env.DEMO_OWNER_EMAIL;
  const demoPassword = process.env.DEMO_OWNER_PASSWORD;
  if (!demoEmail || !demoPassword || demoPassword.length < 12) {
    return fail(503, "CONFIGURATION_ERROR", "DEMO_OWNER_EMAIL and DEMO_OWNER_PASSWORD (12+ chars) must be configured.");
  }
  const accounts = [{ email: demoEmail, password: demoPassword, businessName: process.env.DEMO_BUSINESS_NAME || "Demo Store" }];
  const secondEmail = process.env.DEMO_SECOND_OWNER_EMAIL;
  const secondPassword = process.env.DEMO_SECOND_OWNER_PASSWORD;
  if (secondEmail || secondPassword) {
    if (!secondEmail || !secondPassword || secondPassword.length < 12 || secondEmail.toLowerCase() === demoEmail.toLowerCase()) return fail(503, "CONFIGURATION_ERROR", "Second demo account requires a distinct email and a password of at least 12 characters.");
    accounts.push({ email: secondEmail, password: secondPassword, businessName: process.env.DEMO_SECOND_BUSINESS_NAME || "New Demo Store" });
  }
  sessionSecret(); // fail on missing config before revealing whether credentials matched
  const matched = accounts.find(account => {
    const emailOk = safeEqual(email.toLowerCase(), account.email.toLowerCase());
    const passwordOk = safeEqual(password, account.password);
    return emailOk && passwordOk;
  });
  if (!matched) return fail(401, "UNAUTHORIZED", "Invalid email or password.");

  const { owner, business } = repository().ensureOwnerBusiness(matched.email.toLowerCase(), matched.businessName);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  repository().createSession(owner.id, hashToken(token), expiresAt);
  const session: Session = { owner, business: { id: business.id, slug: business.slug, name: business.name }, expiresAt };
  return { session, setCookie: cookieHeader(token, SESSION_TTL_MS / 1000) };
}

export function logout(req: Request) {
  assertSameOrigin(req);
  const token = readCookie(req);
  if (token) repository().deleteSession(hashToken(token));
  return cookieHeader("", 0);
}

export type Owner = { ownerId: string; email: string; businessId: string; slug: string; name: string; expiresAt: string };

/** Session from cookie, or null. Never trusts caller-supplied owner/business IDs. */
export function currentOwner(req: Request): Owner | null {
  const token = readCookie(req);
  return token ? repository().findSession(hashToken(token)) ?? null : null;
}

/** For every private route: authenticated owner, plus same-origin check on state-changing methods. */
export function requireOwner(req: Request): Owner {
  if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);
  return currentOwner(req) ?? fail(401, "UNAUTHORIZED", "Sign in required.");
}

export const toSession = (o: Owner): Session => ({
  owner: { id: o.ownerId, email: o.email },
  business: { id: o.businessId, slug: o.slug, name: o.name },
  expiresAt: o.expiresAt,
});
