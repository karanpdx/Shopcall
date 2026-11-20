/**
 * Server-only notification types. Never import from client components.
 *
 * State model (provider states are kept separate on purpose):
 *   pending        – queued, not yet accepted by Resend (may carry retry info)
 *   accepted       – Resend returned an email id. NOT proof of delivery.
 *   delivered      – Resend reported last_event "delivered" (or later engagement)
 *   delivery_failed– Resend reported bounced/failed/suppressed/canceled
 *   send_failed    – permanent send error or retries exhausted; nothing accepted
 *   cancelled      – publication no longer verified at send time; nothing sent
 */
export type NotificationStatus =
  | "pending"
  | "accepted"
  | "delivered"
  | "delivery_failed"
  | "send_failed"
  | "cancelled";

/**
 * Publication facts read from a trusted server-side source (B's job store /
 * C's publication worker). Never constructed from request bodies or model
 * tool output.
 */
export type VerifiedPublication = {
  jobId: string;
  businessId: string;
  businessName: string;
  /** Owner email bound to businessId server-side; not caller-supplied. */
  ownerEmail: string;
  phase: "ready";
  publicUrl: string;
  catalogRevision: number;
  verification: {
    verifiedAt: string;
    /** URL actually fetched anonymously by the verifier. */
    verifiedUrl: string;
    httpStatus: number;
    businessIdMatched: boolean;
    catalogRevisionMatched: boolean;
  };
};

/** Implemented by the job/publication owner. Return null when job unknown. */
export interface VerifiedPublicationSource {
  getPublication(jobId: string): Promise<unknown | null>;
}

export type EmailPayload = {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  tags: { name: string; value: string }[];
};

export type OutboxRecord = {
  id: string;
  kind: "publication_ready";
  /** Unique per job+revision; enqueue is idempotent on this. */
  dedupeKey: string;
  /** Sent as Resend Idempotency-Key; identical on every retry. */
  idempotencyKey: string;
  jobId: string;
  businessId: string;
  catalogRevision: number;
  publicUrl: string;
  /** Rendered once at enqueue so every retry sends a byte-identical payload. */
  payload: EmailPayload;
  status: NotificationStatus;
  attempts: number;
  maxAttempts: number;
  firstAttemptAt: string | null;
  nextAttemptAt: string;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  providerMessageId: string | null;
  providerLastEvent: string | null;
  lastError: string | null;
  acceptedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewOutboxRecord = Omit<
  OutboxRecord,
  | "id" | "status" | "attempts" | "firstAttemptAt" | "leaseToken" | "leaseExpiresAt"
  | "providerMessageId" | "providerLastEvent" | "lastError" | "acceptedAt" | "deliveredAt"
  | "createdAt" | "updatedAt"
>;

export type OutboxPatch = Partial<Pick<
  OutboxRecord,
  | "status" | "nextAttemptAt" | "providerMessageId" | "providerLastEvent" | "lastError"
  | "acceptedAt" | "deliveredAt"
>>;

/**
 * Persistent outbox. Durable implementation (SQLite/Postgres) belongs to the
 * storage owner; `createInMemoryNotificationOutbox` is for tests/dev only.
 *
 * Required guarantees for a durable implementation:
 * - `enqueue` is atomic and unique on `dedupeKey` (return existing on conflict).
 * - `claimDue` atomically selects status="pending", nextAttemptAt<=now, and
 *   (leaseExpiresAt is null or < now); sets a fresh leaseToken/leaseExpiresAt,
 *   increments attempts, sets firstAttemptAt if null, and persists BEFORE
 *   returning (so a crash mid-send still counts the attempt).
 * - `completeClaim` applies the patch only if leaseToken still matches, clears
 *   the lease, and returns false otherwise.
 */
export interface NotificationOutboxRepository {
  enqueue(record: NewOutboxRecord, now: Date): Promise<{ record: OutboxRecord; created: boolean }>;
  claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxRecord[]>;
  completeClaim(id: string, leaseToken: string, patch: OutboxPatch, now: Date): Promise<boolean>;
  listAwaitingDelivery(limit: number): Promise<OutboxRecord[]>;
  update(id: string, patch: OutboxPatch, now: Date): Promise<void>;
  findByJob(jobId: string): Promise<OutboxRecord[]>;
}

export type NotificationErrorCode =
  | "NOT_FOUND"
  | "NOT_VERIFIED"
  | "INVALID_PUBLICATION"
  | "INVALID_URL"
  | "INVALID_RECIPIENT"
  | "NOT_CONFIGURED";

export type EnqueueResult =
  | { ok: true; record: OutboxRecord; created: boolean }
  | { ok: false; error: { code: NotificationErrorCode; message: string } };
