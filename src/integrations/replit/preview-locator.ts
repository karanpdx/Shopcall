import { z } from "zod";
import type { ReplitMcpClient } from "./client";

export type PreviewLocationObservation =
  | { state: "candidate"; url: string; source: "agent-candidate" }
  | { state: "pending"; code: "REPLIT_AGENT_BUSY" | "PREVIEW_LOCATION_UNAVAILABLE" }
  | { state: "blocked"; code: "PREVIEW_RESPONSE_UNVERIFIED" };

const answer = z.object({ replId: z.string(), phase: z.enum(["busy", "paused"]), response: z.string() }).strict();

/** URL candidate only: caller must perform independent fresh HTTP/browser/catalog verification. */
function previewCandidate(value: string, allowedSuffixes: readonly string[]) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !allowedSuffixes.some(suffix => url.hostname.endsWith(`.${suffix}`))) return null;
    return url.href;
  } catch { return null; }
}

/**
 * Dynamic candidate locator for newly created apps. Internal widget tools explicitly forbid
 * direct external use; only documented ask_question supplies an untrusted URL candidate.
 * Independent browser/network checks are required. Private preview shielding can still block it.
 */
export class ReplitLivePreviewLocator {
  constructor(
    private readonly client: Pick<ReplitMcpClient, "call">,
    private readonly allowedSuffixes: readonly string[] = ["replit.dev"],
  ) {
    if (!allowedSuffixes.length || allowedSuffixes.some(suffix => !/^[a-z0-9.-]+$/.test(suffix) || !suffix.includes(".") || suffix.startsWith("."))) {
      throw new Error("Preview suffixes must come from trusted deployment configuration.");
    }
  }

  async locate(replId: string): Promise<string | null> {
    const observation = await this.locateDetailed(replId);
    return observation.state === "candidate" ? observation.url : null;
  }

  async locateDetailed(replId: string): Promise<PreviewLocationObservation> {
    const raw = await this.client.call("ask_question", {
      replId,
      question: "Read-only runtime location inspection. Do not change files, run processes, update, or publish. Return the exact current development preview HTTPS URL with no credentials/query parameters. Prefer JSON with previewUrl. Never invent this value or reveal any credentials. If unavailable, say unavailable. This metadata is only a candidate for an independent browser check, not proof of build completion.",
    });
    const parsed = answer.safeParse(raw.structuredContent);
    if (!parsed.success || parsed.data.replId !== replId) return { state: "blocked", code: "PREVIEW_RESPONSE_UNVERIFIED" };
    if (parsed.data.phase !== "paused") return { state: "pending", code: "REPLIT_AGENT_BUSY" };
    const text = parsed.data.response;
    let value: Record<string, unknown> = {};
    try {
      const json: unknown = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
      if (json && typeof json === "object" && !Array.isArray(json)) value = json as Record<string, unknown>;
    } catch { /* Unstructured Agent text may provide a URL candidate; never acceptance evidence. */ }

    const candidates = [
      ...(typeof value.previewUrl === "string" ? [value.previewUrl] : []),
      ...[...text.matchAll(/https:\/\/[^\s<>"'`]+/g)].map(match => match[0].replace(/[),.;]+$/, "")),
    ];
    for (const candidate of candidates) {
      const valid = previewCandidate(candidate, this.allowedSuffixes);
      if (valid) return { state: "candidate", url: valid, source: "agent-candidate" };
    }
    return { state: "pending", code: "PREVIEW_LOCATION_UNAVAILABLE" };
  }
}
