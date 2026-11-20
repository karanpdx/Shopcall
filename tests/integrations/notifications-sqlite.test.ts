import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteNotificationOutbox } from "../../src/integrations/notifications/outbox-sqlite";
import type { NewOutboxRecord } from "../../src/integrations/notifications/types";

const NOW = new Date("2026-11-20T10:05:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const input = (key = "one"): NewOutboxRecord => ({ kind: "publication_ready", dedupeKey: key, idempotencyKey: `shopcall/${key}`, jobId: "job-1", businessId: "business-1", catalogRevision: 3, publicUrl: "https://shop.replit.app/", payload: { from: "Shopcall <notify@example.com>", to: ["owner@example.com"], subject: "Live", html: "<p>Your storefront is live.</p>", text: "Your storefront is live.", tags: [] }, maxAttempts: 6, nextAttemptAt: NOW.toISOString() });

async function directory() { return mkdtemp(join(tmpdir(), "shopcall-outbox-test-")); }

test("durable enqueue deduplicates across connections and preserves original payload/key after restart", async () => {
  const dir = await directory();
  const path = join(dir, "notifications.sqlite");
  let first: SqliteNotificationOutbox | undefined;
  let second: SqliteNotificationOutbox | undefined;
  try {
    first = new SqliteNotificationOutbox(path);
    second = new SqliteNotificationOutbox(path);
    const a = await first.enqueue(input(), NOW);
    const changed = { ...input(), payload: { ...input().payload, subject: "Changed" } };
    const b = await second.enqueue(changed, later(10));
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.record.id, b.record.id);
    assert.equal(b.record.payload.subject, "Live");
    first.close(); first = undefined;
    second.close(); second = new SqliteNotificationOutbox(path);
    assert.deepEqual(await second.findByJob("job-1"), [a.record]);
  } finally { first?.close(); second?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("claim attempts and first-attempt time persist across worker restart; stale or expired token cannot complete", async () => {
  const dir = await directory();
  const path = join(dir, "notifications.sqlite");
  let store = new SqliteNotificationOutbox(path);
  try {
    const { record } = await store.enqueue(input(), NOW);
    const [claim] = await store.claimDue(NOW, 10, 1000);
    assert.equal(claim.attempts, 1);
    assert.equal(claim.firstAttemptAt, NOW.toISOString());
    assert.equal((await store.claimDue(later(500), 10, 1000)).length, 0);
    store.close(); store = new SqliteNotificationOutbox(path);
    assert.equal((await store.findByJob("job-1"))[0].leaseToken, claim.leaseToken);
    assert.equal(await store.completeClaim(record.id, claim.leaseToken!, { status: "accepted" }, later(1001)), false);
    const [reclaimed] = await store.claimDue(later(1001), 10, 1000);
    assert.notEqual(reclaimed.leaseToken, claim.leaseToken);
    assert.equal(reclaimed.attempts, 2);
    assert.equal(reclaimed.firstAttemptAt, NOW.toISOString());
    assert.equal(await store.completeClaim(record.id, claim.leaseToken!, { status: "accepted" }, later(1002)), false);
    assert.equal(await store.completeClaim(record.id, reclaimed.leaseToken!, { status: "accepted", providerMessageId: "email-1", acceptedAt: later(1002).toISOString() }, later(1002)), true);
    assert.equal(await store.completeClaim(record.id, reclaimed.leaseToken!, { status: "send_failed" }, later(1003)), false);
    const saved = (await store.findByJob("job-1"))[0];
    assert.equal(saved.status, "accepted");
    assert.equal(saved.leaseToken, null);
    assert.equal(saved.attempts, 2);
    assert.equal((await store.listAwaitingDelivery(10))[0].providerMessageId, "email-1");
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("retry scheduling and terminal delivery evidence survive restarts and stale delivery polls", async () => {
  const dir = await directory();
  const path = join(dir, "notifications.sqlite");
  let store = new SqliteNotificationOutbox(path);
  try {
    await store.enqueue(input(), NOW);
    const [claim] = await store.claimDue(NOW, 10, 5000);
    // A delivery poll cannot bypass a currently held send lease.
    await store.update(claim.id, { status: "delivered" }, later(1));
    assert.equal((await store.findByJob("job-1"))[0].status, "pending");
    await store.completeClaim(claim.id, claim.leaseToken!, { status: "pending", lastError: "network timeout", nextAttemptAt: later(30_000).toISOString() }, later(100));
    store.close(); store = new SqliteNotificationOutbox(path);
    assert.equal((await store.claimDue(later(29_999), 1, 5000)).length, 0);
    const [retry] = await store.claimDue(later(30_000), 1, 5000);
    assert.equal(retry.idempotencyKey, claim.idempotencyKey);
    assert.deepEqual(retry.payload, claim.payload);
    await store.completeClaim(retry.id, retry.leaseToken!, { status: "accepted", providerMessageId: "email-1" }, later(30_100));
    await store.update(retry.id, { status: "delivered", providerLastEvent: "delivered", deliveredAt: later(31_000).toISOString() }, later(31_000));
    await store.update(retry.id, { status: "accepted", providerLastEvent: "sent" }, later(31_100));
    assert.equal((await store.findByJob("job-1"))[0].status, "delivered");
    assert.equal((await store.listAwaitingDelivery(10)).length, 0);
    store.close(); store = new SqliteNotificationOutbox(path);
    assert.equal((await store.findByJob("job-1"))[0].deliveredAt, later(31_000).toISOString());
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("due times normalize offsets and invalid lease/patch input cannot corrupt rows", async () => {
  const dir = await directory();
  const store = new SqliteNotificationOutbox(join(dir, "notifications.sqlite"));
  try {
    await store.enqueue({ ...input(), nextAttemptAt: "2026-11-20T02:05:00-08:00" }, NOW);
    const [claim] = await store.claimDue(NOW, 1, 1000);
    assert.equal(claim.nextAttemptAt, NOW.toISOString());
    await assert.rejects(store.claimDue(NOW, -1, 1000));
    await assert.rejects(store.claimDue(NOW, 1, 0));
    await assert.rejects(store.completeClaim(claim.id, claim.leaseToken!, { payload: "tamper" } as never, NOW));
    await assert.rejects(store.update(claim.id, { nextAttemptAt: "invalid" }, NOW));
    assert.equal((await store.findByJob("job-1"))[0].attempts, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("file/sidecars stay private; shared directory and symlink storage are rejected", async () => {
  const dir = await directory();
  const path = join(dir, "notifications.sqlite");
  const store = new SqliteNotificationOutbox(path);
  try {
    await store.enqueue(input(), NOW);
    for (const file of [path, `${path}-wal`, `${path}-shm`]) assert.equal((await stat(file)).mode & 0o077, 0);
    const link = join(dir, "link.sqlite");
    await symlink(path, link);
    assert.throws(() => new SqliteNotificationOutbox(link), /regular file/);
    assert.throws(() => new SqliteNotificationOutbox(":memory:"), /persistent file/);
    await chmod(dir, 0o755);
    assert.throws(() => new SqliteNotificationOutbox(join(dir, "unsafe.sqlite")), /private directory/);
  } finally { store.close(); await chmod(dir, 0o700); await rm(dir, { recursive: true, force: true }); }
});

function competingWorker(path: string): Promise<{ created: boolean; ids: string[] }> {
  const modulePath = fileURLToPath(new URL("../../src/integrations/notifications/outbox-sqlite.ts", import.meta.url));
  const code = `import { SqliteNotificationOutbox } from ${JSON.stringify(modulePath)};
    const store = new SqliteNotificationOutbox(process.argv[1]);
    const enqueued = await store.enqueue(${JSON.stringify(input())}, new Date(${JSON.stringify(NOW.toISOString())}));
    const rows = await store.claimDue(new Date(${JSON.stringify(NOW.toISOString())}), 8, 60000);
    store.close(); console.log(JSON.stringify({created: enqueued.created, ids: rows.map(row => row.id)}));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, path], { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let error = "";
    child.stdout.on("data", chunk => { out += chunk.toString(); }); child.stderr.on("data", chunk => { error += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => { if (code !== 0) reject(new Error(`Outbox test worker failed: ${error}`)); else { try { resolve(JSON.parse(out)); } catch (error) { reject(error); } } });
  });
}

test("independent OS processes cannot duplicate enqueue or claim the same due row", { timeout: 15_000 }, async () => {
  const dir = await directory();
  const path = join(dir, "notifications.sqlite");
  let store = new SqliteNotificationOutbox(path);
  try {
    for (let i = 0; i < 14; i++) await store.enqueue(input(`seed-${i}`), NOW);
    store.close();
    const results = await Promise.all([competingWorker(path), competingWorker(path)]);
    store = new SqliteNotificationOutbox(path);
    assert.equal(results.filter(result => result.created).length, 1);
    const claimed = results.flatMap(result => result.ids);
    assert.equal(claimed.length, 15);
    assert.equal(new Set(claimed).size, claimed.length);
    assert.equal((await store.findByJob("job-1")).length, 15);
    assert.equal((await store.claimDue(later(1000), 100, 1000)).length, 0);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
