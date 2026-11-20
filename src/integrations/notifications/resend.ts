import type { EmailPayload } from "./types";

/**
 * Minimal Resend REST client over built-in fetch.
 * Docs: https://resend.com/docs/api-reference/emails/send-email
 *       https://resend.com/docs/api-reference/errors
 *       https://resend.com/docs/dashboard/emails/idempotency-keys
 */

export type SendOutcome =
  | { kind: "accepted"; id: string }
  /** Safe to retry with the SAME idempotency key and payload. */
  | { kind: "retryable"; error: string; retryAfterMs: number | null }
  /** Retrying the same request cannot succeed. */
  | { kind: "permanent"; error: string };

export type EmailEventOutcome =
  | { kind: "event"; lastEvent: string }
  | { kind: "error"; error: string };

export interface ResendClient {
  sendEmail(payload: EmailPayload, idempotencyKey: string): Promise<SendOutcome>;
  getEmailLastEvent(id: string): Promise<EmailEventOutcome>;
}

export type ResendClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const USER_AGENT = "shopcall-notifications/0.1";
const RETRYABLE_409 = new Set(["concurrent_idempotent_requests", "resource_locked"]);

export function createResendClient(options: ResendClientOptions): ResendClient {
  const baseUrl = (options.baseUrl ?? "https://api.resend.com").replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const headers = {
    Authorization: `Bearer ${options.apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  const redact = (text: string) => text.split(options.apiKey).join("[redacted]").slice(0, 500);

  return {
    async sendEmail(payload, idempotencyKey) {
      if (idempotencyKey.length < 1 || idempotencyKey.length > 256) {
        return { kind: "permanent", error: "idempotency key must be 1-256 characters" };
      }
      const body = {
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        ...(payload.replyTo ? { reply_to: payload.replyTo } : {}),
        tags: payload.tags,
      };
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/emails`, {
          method: "POST",
          headers: { ...headers, "Idempotency-Key": idempotencyKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // Outcome unknown (timeout/network). Same idempotency key makes retry safe.
        return { kind: "retryable", error: redact(`network: ${errorMessage(err)}`), retryAfterMs: null };
      }
      const json = await readJson(res);
      if (res.ok) {
        const id = typeof json?.id === "string" && json.id.length > 0 ? json.id : null;
        // 2xx without an id: outcome unknown; replaying the same key returns the original id.
        return id
          ? { kind: "accepted", id }
          : { kind: "retryable", error: "provider 2xx without email id", retryAfterMs: null };
      }
      const name = typeof json?.name === "string" ? json.name : "unknown_error";
      const message = typeof json?.message === "string" ? json.message : res.statusText;
      const error = redact(`resend ${res.status} ${name}: ${message}`);
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      if (res.status === 429 && name === "rate_limit_exceeded") return { kind: "retryable", error, retryAfterMs };
      if (res.status === 409 && RETRYABLE_409.has(name)) return { kind: "retryable", error, retryAfterMs };
      if (res.status >= 500) return { kind: "retryable", error, retryAfterMs };
      // 400/401/403/404/405/422, 409 invalid_idempotent_request, 429 daily/monthly quota.
      return { kind: "permanent", error };
    },

    async getEmailLastEvent(id) {
      try {
        const res = await doFetch(`${baseUrl}/emails/${encodeURIComponent(id)}`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const json = await readJson(res);
        if (!res.ok) return { kind: "error", error: redact(`resend ${res.status} ${json?.name ?? "error"}`) };
        if (typeof json?.last_event !== "string") return { kind: "error", error: "missing last_event" };
        return { kind: "event", lastEvent: json.last_event };
      } catch (err) {
        return { kind: "error", error: redact(`network: ${errorMessage(err)}`) };
      }
    },
  };
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await res.json();
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 3600) * 1000 : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
