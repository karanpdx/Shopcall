import { z } from "zod";
import type { ReplitMcpClient } from "./client";

const answer = z.object({ replId: z.string(), phase: z.enum(["busy", "paused"]), response: z.string() }).strict();
const nativePreview = z.object({
  status: z.enum(["ok", "error"]),
  error: z.string().optional(),
  preview: z.object({ url: z.string(), expiresAt: z.string().nullable() }).strict().nullable(),
}).strict();

/** URL candidate only: caller must perform independent fresh HTTP/browser/catalog verification. */
function previewCandidate(value: string, allowedSuffixes: readonly string[]) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !allowedSuffixes.some(suffix => url.hostname.endsWith(`.${suffix}`))) return null;
    return url.href;
  } catch { return null; }
}

/**
 * Dynamic locator for newly created apps. Uses provider-bound preview lookup when actual
 * checkpoint metadata is available; otherwise accepts an untrusted Agent URL candidate
 * only within configured Replit preview domains. Neither path attests build success.
 */
export class ReplitLivePreviewLocator {
  constructor(
    private readonly client: Pick<ReplitMcpClient, "call" | "getPreviewUrl">,
    private readonly allowedSuffixes: readonly string[] = ["replit.dev"],
    private readonly now = () => new Date(),
  ) {
    if (!allowedSuffixes.length || allowedSuffixes.some(suffix => !/^[a-z0-9.-]+$/.test(suffix) || !suffix.includes(".") || suffix.startsWith("."))) {
      throw new Error("Preview suffixes must come from trusted deployment configuration.");
    }
  }

  async locate(replId: string): Promise<string | null> {
    const raw = await this.client.call("ask_question", {
      replId,
      question: "Read-only runtime location inspection. Do not change files, run processes, update, or publish. Return the exact current development preview HTTPS URL with no credentials/query parameters, and the actual current Git commit SHA if available. Prefer JSON with previewUrl and gitSha. Never invent these values or reveal any credentials. If unavailable, say unavailable. This metadata is only a candidate for an independent browser check, not proof of build completion.",
    });
    const parsed = answer.safeParse(raw.structuredContent);
    if (!parsed.success || parsed.data.replId !== replId || parsed.data.phase !== "paused") return null;
    const text = parsed.data.response;
    let value: Record<string, unknown> = {};
    try {
      const json: unknown = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
      if (json && typeof json === "object" && !Array.isArray(json)) value = json as Record<string, unknown>;
    } catch { /* Unstructured Agent text may provide a URL candidate; never acceptance evidence. */ }

    const sha = typeof value.gitSha === "string" && /^[a-f0-9]{40}$/i.test(value.gitSha)
      ? value.gitSha : text.match(/\b[a-f0-9]{40}\b/i)?.[0];
    if (sha) {
      const lookup = await this.client.getPreviewUrl({ replId, gitSha: sha, timestamp: this.now().toISOString() });
      const result = nativePreview.safeParse(lookup.structuredContent);
      if (result.success && result.data.status === "ok" && result.data.preview) {
        const expiresAt = result.data.preview.expiresAt;
        const expiry = expiresAt === null ? null : Date.parse(expiresAt);
        if (expiry === null || (Number.isFinite(expiry) && expiry > this.now().getTime())) {
          const candidate = previewCandidate(result.data.preview.url, this.allowedSuffixes);
          if (candidate) return candidate;
        }
      }
    }
    const candidates = [
      ...(typeof value.previewUrl === "string" ? [value.previewUrl] : []),
      ...[...text.matchAll(/https:\/\/[^\s<>"'`]+/g)].map(match => match[0].replace(/[),.;]+$/, "")),
    ];
    for (const candidate of candidates) {
      const valid = previewCandidate(candidate, this.allowedSuffixes);
      if (valid) return valid;
    }
    return null;
  }
}
