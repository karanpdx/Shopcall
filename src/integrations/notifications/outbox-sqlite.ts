import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { NewOutboxRecord, NotificationOutboxRepository, OutboxPatch, OutboxRecord } from "./types";

const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)), "Invalid timestamp").transform(value => new Date(value).toISOString());
const status = z.enum(["pending", "accepted", "delivered", "delivery_failed", "send_failed", "cancelled"]);
const inputSchema = z.object({
  kind: z.literal("publication_ready"), dedupeKey: z.string().min(1).max(500), idempotencyKey: z.string().min(1).max(256),
  jobId: z.string().min(1).max(200), businessId: z.string().min(1).max(200), catalogRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  publicUrl: z.url(), payload: z.object({ from: z.string(), to: z.array(z.string()).min(1), subject: z.string(), html: z.string(), text: z.string(), replyTo: z.string().optional(), tags: z.array(z.object({ name: z.string(), value: z.string() }).strict()) }).strict(),
  maxAttempts: z.number().int().min(1).max(1000), nextAttemptAt: timestamp,
}).strict();
const patchSchema = z.object({
  status: status.optional(), nextAttemptAt: timestamp.optional(), providerMessageId: z.string().nullable().optional(),
  providerLastEvent: z.string().nullable().optional(), lastError: z.string().nullable().optional(),
  acceptedAt: timestamp.nullable().optional(), deliveredAt: timestamp.nullable().optional(),
}).strict();

const TABLE = "shopcall_notification_outbox_v1";
const columns = ["id", "kind", "dedupeKey", "idempotencyKey", "jobId", "businessId", "catalogRevision", "publicUrl", "payload", "status", "attempts", "maxAttempts", "firstAttemptAt", "nextAttemptAt", "leaseToken", "leaseExpiresAt", "providerMessageId", "providerLastEvent", "lastError", "acceptedAt", "deliveredAt", "createdAt", "updatedAt"] as const;
type Row = Omit<OutboxRecord, "payload"> & { payload: string };
function hydrate(raw: unknown): OutboxRecord {
  const row = raw as Row;
  return { ...row, payload: JSON.parse(row.payload) as OutboxRecord["payload"] };
}
function iso(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Notification outbox requires a valid clock.");
  return now.toISOString();
}
function boundedInteger(value: number, name: string, max: number) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid notification ${name}.`);
}

/**
 * Durable single-host outbox. Multiple processes/connections share one private local
 * file. Requires persistent local disk; do not use an ephemeral/serverless/NFS path.
 */
export class SqliteNotificationOutbox implements NotificationOutboxRepository {
  private readonly db: Database.Database;

  constructor(databasePath = ".shopcall/notifications.sqlite") {
    if (!databasePath || databasePath === ":memory:" || databasePath.startsWith("file:")) throw new Error("Notification outbox requires a persistent file path.");
    const path = resolve(databasePath);
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (process.platform !== "win32" && (parent.mode & 0o077) !== 0)) {
      throw new Error("Notification outbox requires a private directory (mode 0700).");
    }
    // Create without following a symlink and set permissions before SQLite writes PII.
    try { closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error("Notification outbox path must be a regular file.");
    chmodSync(path, 0o600);
    this.db = new Database(path, { timeout: 5000 });
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind = 'publication_ready'),
        dedupeKey TEXT NOT NULL UNIQUE, idempotencyKey TEXT NOT NULL UNIQUE,
        jobId TEXT NOT NULL, businessId TEXT NOT NULL, catalogRevision INTEGER NOT NULL CHECK(catalogRevision >= 0),
        publicUrl TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
        status TEXT NOT NULL CHECK(status IN ('pending','accepted','delivered','delivery_failed','send_failed','cancelled')),
        attempts INTEGER NOT NULL CHECK(attempts >= 0), maxAttempts INTEGER NOT NULL CHECK(maxAttempts > 0),
        firstAttemptAt TEXT, nextAttemptAt TEXT NOT NULL, leaseToken TEXT, leaseExpiresAt TEXT,
        providerMessageId TEXT, providerLastEvent TEXT, lastError TEXT, acceptedAt TEXT, deliveredAt TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        CHECK((leaseToken IS NULL) = (leaseExpiresAt IS NULL))
      );
      CREATE INDEX IF NOT EXISTS shopcall_notification_due_v1 ON ${TABLE}(status,nextAttemptAt,leaseExpiresAt);
      CREATE INDEX IF NOT EXISTS shopcall_notification_job_v1 ON ${TABLE}(jobId,catalogRevision);`);
      // SQLite sidecars inherit database permissions; enforce existing sidecars too.
      for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
        try { const stat = lstatSync(sidecar); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe notification sidecar path."); chmodSync(sidecar, 0o600); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    } catch (error) { this.db.close(); throw error; }
  }

  close(): void { if (this.db.open) this.db.close(); }

  async enqueue(input: NewOutboxRecord, now: Date): Promise<{ record: OutboxRecord; created: boolean }> {
    const validated = inputSchema.parse(input);
    const ts = iso(now);
    return this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT * FROM ${TABLE} WHERE dedupeKey = ?`).get(validated.dedupeKey);
      if (existing) return { record: hydrate(existing), created: false };
      const record: OutboxRecord = { ...validated, id: randomUUID(), status: "pending", attempts: 0,
        firstAttemptAt: null, leaseToken: null, leaseExpiresAt: null, providerMessageId: null, providerLastEvent: null,
        lastError: null, acceptedAt: null, deliveredAt: null, createdAt: ts, updatedAt: ts };
      this.db.prepare(`INSERT INTO ${TABLE} (${columns.join(",")}) VALUES (${columns.map(key => `@${key}`).join(",")})`).run({ ...record, payload: JSON.stringify(record.payload) });
      return { record: structuredClone(record), created: true };
    }).immediate();
  }

  async claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxRecord[]> {
    boundedInteger(limit, "claim limit", 1000);
    boundedInteger(leaseMs, "lease duration", 24 * 60 * 60_000);
    const ts = iso(now);
    const expires = new Date(now.getTime() + leaseMs).toISOString();
    return this.db.transaction(() => {
      const due = this.db.prepare(`SELECT id FROM ${TABLE} WHERE status='pending' AND nextAttemptAt <= ?
        AND (leaseExpiresAt IS NULL OR leaseExpiresAt < ?) ORDER BY nextAttemptAt,createdAt,id LIMIT ?`).all(ts, ts, limit) as { id: string }[];
      const update = this.db.prepare(`UPDATE ${TABLE} SET leaseToken=?, leaseExpiresAt=?, attempts=attempts+1,
        firstAttemptAt=COALESCE(firstAttemptAt,?), updatedAt=? WHERE id=?`);
      const read = this.db.prepare(`SELECT * FROM ${TABLE} WHERE id=?`);
      return due.map(({ id }) => { update.run(randomUUID(), expires, ts, ts, id); return hydrate(read.get(id)); });
    }).immediate();
  }

  async completeClaim(id: string, leaseToken: string, patch: OutboxPatch, now: Date): Promise<boolean> {
    if (!leaseToken) return false;
    const parsed = patchSchema.parse(patch);
    const ts = iso(now);
    const entries = Object.entries(parsed).filter(([, value]) => value !== undefined);
    const params = Object.fromEntries(entries);
    // A token whose lease expired cannot complete even if nobody reclaimed it yet.
    const result = this.db.prepare(`UPDATE ${TABLE} SET ${entries.map(([key]) => `${key}=@${key},`).join("")}
      leaseToken=NULL, leaseExpiresAt=NULL, updatedAt=@updatedAt
      WHERE id=@id AND status='pending' AND leaseToken=@leaseToken AND leaseExpiresAt > @updatedAt`).run({ ...params, id, leaseToken, updatedAt: ts });
    return result.changes === 1;
  }

  async listAwaitingDelivery(limit: number): Promise<OutboxRecord[]> {
    boundedInteger(limit, "delivery limit", 1000);
    return this.db.prepare(`SELECT * FROM ${TABLE} WHERE status='accepted' ORDER BY acceptedAt,id LIMIT ?`).all(limit).map(hydrate);
  }

  async update(id: string, patch: OutboxPatch, now: Date): Promise<void> {
    const parsed = patchSchema.parse(patch);
    const entries = Object.entries(parsed).filter(([, value]) => value !== undefined);
    const ts = iso(now);
    // Delivery polls may overlap. Preserve terminal evidence against stale polls,
    // and never let this non-claim operation change an in-flight send.
    this.db.prepare(`UPDATE ${TABLE} SET ${entries.map(([key]) => `${key}=@${key},`).join("")}updatedAt=@updatedAt
      WHERE id=@id AND leaseToken IS NULL AND status NOT IN ('delivered','delivery_failed','send_failed','cancelled')`).run({ ...Object.fromEntries(entries), id, updatedAt: ts });
  }

  async findByJob(jobId: string): Promise<OutboxRecord[]> {
    return this.db.prepare(`SELECT * FROM ${TABLE} WHERE jobId=? ORDER BY catalogRevision,createdAt,id`).all(jobId).map(hydrate);
  }
}
