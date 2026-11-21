import { z } from "zod";
import type { ReplitToolResult } from "./client";

const path = z.array(z.string().min(1).refine(value => !["__proto__", "constructor", "prototype"].includes(value))).min(1).max(12);
/** Fill ONLY after observing real Replit structured responses. No guessed defaults. */
export const responseProfileSchema = z.object({
  verifiedAt: z.iso.datetime(),
  creationIdPath: path,
  build: z.object({ statusPath: path, readyValues: z.array(z.string()).min(1), pendingValues: z.array(z.string()), failedValues: z.array(z.string()) }).strict().optional(),
  publication: z.object({ statusPath: path, readyValues: z.array(z.string()).min(1), pendingValues: z.array(z.string()), failedValues: z.array(z.string()), urlPath: path, presencePath: path.optional() }).strict(),
}).strict();
export type ReplitResponseProfile = z.infer<typeof responseProfileSchema>;
export type CreationResult = { state: "created"; replId: string } | { state: "blocked"; reason: string };
export type ReadinessResult = { state: "ready" } | { state: "pending" } | { state: "failed" } | { state: "blocked"; reason: string };
export type PublishResult = { state: "ready"; publicUrl: string } | { state: "pending" | "failed" } | { state: "blocked"; reason: string };

function read(root: unknown, at: string[]) {
  let current = root;
  for (const key of at) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
function status(value: unknown, shape: { readyValues: string[]; pendingValues: string[]; failedValues: string[] }): ReadinessResult {
  if (typeof value !== "string") return { state: "blocked", reason: "Unrecognized structured provider status. Inspect actual response schema." };
  if (shape.readyValues.includes(value)) return { state: "ready" };
  if (shape.pendingValues.includes(value)) return { state: "pending" };
  if (shape.failedValues.includes(value)) return { state: "failed" };
  return { state: "blocked", reason: "Provider status is outside verified response profile." };
}
export function parseCreationResult(raw: ReplitToolResult, profile?: ReplitResponseProfile): CreationResult {
  if (!profile) return { state: "blocked", reason: "Replit creation output schema has not been verified against this account." };
  const verified = responseProfileSchema.parse(profile);
  const id = read(raw.structuredContent, verified.creationIdPath);
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(id)
    ? { state: "created", replId: id }
    : { state: "blocked", reason: "Replit returned no app ID at the verified structured path. Reconcile before creating again." };
}
export function parseReadinessResult(raw: ReplitToolResult, profile?: ReplitResponseProfile): ReadinessResult {
  if (!profile?.build) return { state: "blocked", reason: "No verified machine-readable Replit build-completion signal. Agent prose is not build evidence." };
  const verified = responseProfileSchema.parse(profile);
  return status(read(raw.structuredContent, verified.build!.statusPath), verified.build!);
}
export function parsePublishResult(raw: ReplitToolResult, profile?: ReplitResponseProfile): PublishResult {
  if (!profile) return { state: "blocked", reason: "Replit publication output schema has not been verified against this account." };
  const verified = responseProfileSchema.parse(profile);
  if (verified.publication.presencePath) {
    const found = read(raw.structuredContent, verified.publication.presencePath);
    if (found === false) return { state: "pending" };
    if (found !== true) return { state: "blocked", reason: "Provider publication presence does not match verified response profile." };
  }
  const rawStatus = read(raw.structuredContent, verified.publication.statusPath);
  let result = status(rawStatus, verified.publication);
  // The live get_publish_status schema explicitly defines every other status as an
  // in-progress lifecycle operation. Do not terminally block on a new progress label;
  // exact verified success/failure values still govern readiness and failure.
  if (result.state === "blocked" && typeof rawStatus === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(rawStatus)) result = { state: "pending" };
  if (result.state !== "ready") return result;
  const rawUrl = read(raw.structuredContent, verified.publication.urlPath);
  try {
    const url = new URL(typeof rawUrl === "string" ? rawUrl : "");
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error();
    return { state: "ready", publicUrl: url.toString() };
  } catch { return { state: "blocked", reason: "Published status lacked a valid HTTPS public URL. Anonymous verification still required." }; }
}
