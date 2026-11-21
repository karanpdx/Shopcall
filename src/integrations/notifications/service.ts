import { z } from "zod";
import { isEmailAddress } from "./config";
import type { ResendClient } from "./resend";
import { renderPublicationReadyEmail, validatePublicUrl } from "./template";
import type {
  EnqueueResult,
  NotificationErrorCode,
  NotificationOutboxRepository,
  NotificationStatus,
  OutboxRecord,
  VerifiedPublication,
  VerifiedPublicationSource,
} from "./types";

export type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Must stay below Resend's 24h idempotency-key retention. */
  maxRetryWindowMs: number;
  leaseMs: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 6,
  baseDelayMs: 30_000,
  maxDelayMs: 30 * 60_000,
  maxRetryWindowMs: 23 * 60 * 60_000,
  leaseMs: 60_000,
};

export type NotificationDeps = {
  outbox: NotificationOutboxRepository;
  publications: VerifiedPublicationSource;
  clock?: () => Date;
};

const verifiedPublicationSchema = z.object({
  jobId: z.string().min(1).max(200),
  businessId: z.string().min(1).max(200),
  businessName: z.string().max(500),
  ownerEmail: z.string(),
  phase: z.literal("ready"),
  publicUrl: z.string(),
  catalogRevision: z.number().int().nonnegative(),
  verification: z.object({
    verifiedAt: z.iso.datetime({ offset: true }),
    verifiedUrl: z.string(),
    httpStatus: z.number().int().min(200).max(299),
    businessIdMatched: z.literal(true),
    catalogRevisionMatched: z.literal(true),
  }),
});

type CheckResult =
  | { ok: true; publication: VerifiedPublication; url: string }
  | { ok: false; error: { code: NotificationErrorCode; message: string } };

/** Re-derives trust from the server-side source every time; never from caller input. */
async function loadVerified(publications: VerifiedPublicationSource, jobId: string): Promise<CheckResult> {
  const raw = await publications.getPublication(jobId);
  if (raw === null || raw === undefined) return fail("NOT_FOUND", "Publication job not found");
  const phase = (raw as { phase?: unknown }).phase;
  if (phase !== "ready") return fail("NOT_VERIFIED", "Publication is not verified");
  const parsed = verifiedPublicationSchema.safeParse(raw);
  if (!parsed.success) return fail("NOT_VERIFIED", "Publication lacks complete anonymous verification evidence");
  const pub = parsed.data;
  if (pub.jobId !== jobId) return fail("INVALID_PUBLICATION", "Publication source returned a different job");
  const url = validatePublicUrl(pub.publicUrl);
  if (!url) return fail("INVALID_URL", "Public URL is not a valid public https URL");
  if (validatePublicUrl(pub.verification.verifiedUrl) !== url) {
    return fail("NOT_VERIFIED", "Verified URL does not match public URL");
  }
  if (!isEmailAddress(pub.ownerEmail)) return fail("INVALID_RECIPIENT", "Owner email is invalid");
  return { ok: true, publication: pub, url };
}

function fail(code: NotificationErrorCode, message: string): { ok: false; error: { code: NotificationErrorCode; message: string } } {
  return { ok: false, error: { code, message } };
}

/**
 * Queue the "storefront is live" email for a verified publication job.
 * Idempotent per (jobId, catalogRevision). Sends nothing itself.
 */
export async function enqueuePublicationReadyEmail(
  deps: NotificationDeps & { sender: { from: string; replyTo?: string }; retry?: Partial<RetryPolicy> },
  input: { jobId: string },
): Promise<EnqueueResult> {
  const now = (deps.clock ?? (() => new Date()))();
  const check = await loadVerified(deps.publications, input.jobId);
  if (!check.ok) return check;
  const { publication: pub, url } = check;
  const content = renderPublicationReadyEmail({ businessName: pub.businessName, publicUrl: url, catalogRevision: pub.catalogRevision });
  const dedupeKey = `publication-ready/${pub.jobId}/${pub.catalogRevision}`;
  const { record, created } = await deps.outbox.enqueue({
    kind: "publication_ready",
    dedupeKey,
    idempotencyKey: `shopcall/${dedupeKey}`.slice(0, 256),
    jobId: pub.jobId,
    businessId: pub.businessId,
    catalogRevision: pub.catalogRevision,
    publicUrl: url,
    payload: {
      from: deps.sender.from,
      to: [pub.ownerEmail],
      ...content,
      ...(deps.sender.replyTo ? { replyTo: deps.sender.replyTo } : {}),
      tags: [
        { name: "category", value: "publication_ready" },
        { name: "job_id", value: tagValue(pub.jobId) },
      ],
    },
    maxAttempts: { ...DEFAULT_RETRY_POLICY, ...deps.retry }.maxAttempts,
    nextAttemptAt: now.toISOString(),
  }, now);
  return { ok: true, record, created };
}

export type ProcessSummary = {
  claimed: number;
  accepted: number;
  retrying: number;
  sendFailed: number;
  cancelled: number;
  leaseLost: number;
};

/**
 * Worker step: claim due outbox rows, re-check verification, send via Resend.
 * "accepted" means Resend took the message; delivery is tracked separately.
 */
export async function processNotificationOutbox(
  deps: NotificationDeps & { resend: ResendClient; retry?: Partial<RetryPolicy> },
  options: { limit?: number } = {},
): Promise<ProcessSummary> {
  const clock = deps.clock ?? (() => new Date());
  const policy = { ...DEFAULT_RETRY_POLICY, ...deps.retry };
  const summary: ProcessSummary = { claimed: 0, accepted: 0, retrying: 0, sendFailed: 0, cancelled: 0, leaseLost: 0 };
  const claimed = await deps.outbox.claimDue(clock(), options.limit ?? 10, policy.leaseMs);
  summary.claimed = claimed.length;

  for (const rec of claimed) {
    const lease = rec.leaseToken;
    if (!lease) continue;
    const finish = async (patch: Parameters<NotificationOutboxRepository["completeClaim"]>[2], bucket: keyof ProcessSummary) => {
      const ok = await deps.outbox.completeClaim(rec.id, lease, patch, clock());
      summary[ok ? bucket : "leaseLost"] += 1;
    };
    const retryOrFail = (error: string, retryAfterMs: number | null) => {
      if (rec.attempts >= rec.maxAttempts) {
        return finish({ status: "send_failed", lastError: `retries exhausted: ${error}` }, "sendFailed");
      }
      const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, rec.attempts - 1));
      const delay = Math.max(backoff, retryAfterMs ?? 0);
      return finish({ status: "pending", lastError: error, nextAttemptAt: new Date(clock().getTime() + delay).toISOString() }, "retrying");
    };

    // A process may have died during the final permitted send. Reclaiming its lease
    // must not create an extra provider attempt after the configured attempt budget.
    if (rec.attempts > rec.maxAttempts) {
      await finish({ status: "send_failed", lastError: "send attempt budget exhausted; prior outcome may require provider reconciliation" }, "sendFailed");
      continue;
    }

    // 1. Publication must still be verified for the same URL and revision.
    let check: CheckResult;
    try {
      check = await loadVerified(deps.publications, rec.jobId);
    } catch {
      await retryOrFail("publication source temporarily unavailable", null);
      continue;
    }
    if (!check.ok || check.url !== rec.publicUrl || check.publication.catalogRevision !== rec.catalogRevision || check.publication.businessId !== rec.businessId || rec.payload.to.length !== 1 || rec.payload.to[0] !== check.publication.ownerEmail) {
      const reason = check.ok ? "publication URL or revision changed since enqueue" : check.error.message;
      await finish({ status: "cancelled", lastError: reason }, "cancelled");
      continue;
    }

    // 2. Never retry past the provider's idempotency window (duplicate-send risk).
    const firstAttempt = rec.firstAttemptAt ? Date.parse(rec.firstAttemptAt) : clock().getTime();
    if (rec.attempts > 1 && clock().getTime() - firstAttempt > policy.maxRetryWindowMs) {
      await finish({ status: "send_failed", lastError: "retry window exceeded provider idempotency retention; prior outcome unknown" }, "sendFailed");
      continue;
    }

    // 3. Send with stable idempotency key and stored payload.
    const outcome = await deps.resend.sendEmail(rec.payload, rec.idempotencyKey);
    if (outcome.kind === "accepted") {
      await finish({ status: "accepted", providerMessageId: outcome.id, providerLastEvent: null, lastError: null, acceptedAt: clock().toISOString() }, "accepted");
    } else if (outcome.kind === "retryable") {
      await retryOrFail(outcome.error, outcome.retryAfterMs);
    } else {
      await finish({ status: "send_failed", lastError: outcome.error }, "sendFailed");
    }
  }
  return summary;
}

const DELIVERED_EVENTS = new Set(["delivered", "opened", "clicked", "complained"]);
const FAILED_EVENTS = new Set(["bounced", "failed", "suppressed", "canceled"]);

/**
 * Poll Resend for accepted messages and promote to delivered / delivery_failed.
 * Polling avoids an unsigned webhook; add a Svix-verified webhook later if needed.
 */
export async function refreshNotificationDeliveryStatus(
  deps: { outbox: NotificationOutboxRepository; resend: ResendClient; clock?: () => Date },
  options: { limit?: number } = {},
): Promise<{ checked: number; delivered: number; deliveryFailed: number; unchanged: number; errors: number }> {
  const clock = deps.clock ?? (() => new Date());
  const out = { checked: 0, delivered: 0, deliveryFailed: 0, unchanged: 0, errors: 0 };
  for (const rec of await deps.outbox.listAwaitingDelivery(options.limit ?? 25)) {
    if (!rec.providerMessageId) continue;
    out.checked += 1;
    const res = await deps.resend.getEmailLastEvent(rec.providerMessageId);
    if (res.kind === "error") {
      out.errors += 1;
      await deps.outbox.update(rec.id, { lastError: `delivery status check: ${res.error}` }, clock());
    } else if (DELIVERED_EVENTS.has(res.lastEvent)) {
      out.delivered += 1;
      await deps.outbox.update(rec.id, { status: "delivered", providerLastEvent: res.lastEvent, deliveredAt: clock().toISOString(), lastError: null }, clock());
    } else if (FAILED_EVENTS.has(res.lastEvent)) {
      out.deliveryFailed += 1;
      await deps.outbox.update(rec.id, { status: "delivery_failed", providerLastEvent: res.lastEvent, lastError: `provider reported ${res.lastEvent}` }, clock());
    } else {
      out.unchanged += 1;
      await deps.outbox.update(rec.id, { providerLastEvent: res.lastEvent }, clock());
    }
  }
  return out;
}

export type PublicationNotificationView = {
  status: NotificationStatus | "none";
  catalogRevision: number | null;
  attempts: number;
  providerLastEvent: string | null;
  lastError: string | null;
  acceptedAt: string | null;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
};

/** Owner-status projection for B's GET /api/jobs/:id. No recipient or body content. */
export async function getPublicationNotificationStatus(
  outbox: NotificationOutboxRepository,
  jobId: string,
): Promise<PublicationNotificationView> {
  const latest = (await outbox.findByJob(jobId)).sort((a, b) => b.catalogRevision - a.catalogRevision)[0] as OutboxRecord | undefined;
  if (!latest) {
    return { status: "none", catalogRevision: null, attempts: 0, providerLastEvent: null, lastError: null, acceptedAt: null, deliveredAt: null, nextAttemptAt: null };
  }
  return {
    status: latest.status,
    catalogRevision: latest.catalogRevision,
    attempts: latest.attempts,
    providerLastEvent: latest.providerLastEvent,
    lastError: latest.lastError,
    acceptedAt: latest.acceptedAt,
    deliveredAt: latest.deliveredAt,
    nextAttemptAt: latest.status === "pending" ? latest.nextAttemptAt : null,
  };
}

function tagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) || "unknown";
}
