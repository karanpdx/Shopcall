import { randomUUID } from "node:crypto";
import type { NewOutboxRecord, NotificationOutboxRepository, OutboxPatch, OutboxRecord } from "./types";

/**
 * In-memory outbox for tests and local dev. NOT durable: state is lost on
 * restart. Production must use a DB-backed implementation honoring the
 * contract on `NotificationOutboxRepository`.
 */
export function createInMemoryNotificationOutbox(): NotificationOutboxRepository & { all(): OutboxRecord[] } {
  const rows = new Map<string, OutboxRecord>();
  const clone = (r: OutboxRecord): OutboxRecord => structuredClone(r);

  return {
    all: () => [...rows.values()].map(clone),

    async enqueue(input: NewOutboxRecord, now: Date) {
      const existing = [...rows.values()].find(r => r.dedupeKey === input.dedupeKey);
      if (existing) return { record: clone(existing), created: false };
      const ts = now.toISOString();
      const record: OutboxRecord = {
        ...structuredClone(input),
        id: randomUUID(),
        status: "pending",
        attempts: 0,
        firstAttemptAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
        providerMessageId: null,
        providerLastEvent: null,
        lastError: null,
        acceptedAt: null,
        deliveredAt: null,
        createdAt: ts,
        updatedAt: ts,
      };
      rows.set(record.id, record);
      return { record: clone(record), created: true };
    },

    async claimDue(now, limit, leaseMs) {
      const t = now.getTime();
      const due = [...rows.values()]
        .filter(r => r.status === "pending"
          && Date.parse(r.nextAttemptAt) <= t
          && (r.leaseExpiresAt === null || Date.parse(r.leaseExpiresAt) < t))
        .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt))
        .slice(0, limit);
      const ts = now.toISOString();
      for (const r of due) {
        r.leaseToken = randomUUID();
        r.leaseExpiresAt = new Date(t + leaseMs).toISOString();
        r.attempts += 1;
        r.firstAttemptAt ??= ts;
        r.updatedAt = ts;
      }
      return due.map(clone);
    },

    async completeClaim(id, leaseToken, patch: OutboxPatch, now) {
      const r = rows.get(id);
      if (!r || r.leaseToken !== leaseToken) return false;
      Object.assign(r, patch, { leaseToken: null, leaseExpiresAt: null, updatedAt: now.toISOString() });
      return true;
    },

    async listAwaitingDelivery(limit) {
      return [...rows.values()].filter(r => r.status === "accepted").slice(0, limit).map(clone);
    },

    async update(id, patch, now) {
      const r = rows.get(id);
      if (r) Object.assign(r, patch, { updatedAt: now.toISOString() });
    },

    async findByJob(jobId) {
      return [...rows.values()].filter(r => r.jobId === jobId).map(clone);
    },
  };
}
