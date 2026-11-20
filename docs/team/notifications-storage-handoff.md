# Durable notification outbox

`SqliteNotificationOutbox` in `src/integrations/notifications/outbox-sqlite.ts` implements the existing `NotificationOutboxRepository` without changing B's catalog DB or routes.

```ts
import { SqliteNotificationOutbox } from "../../src/integrations/notifications/outbox-sqlite";

const outbox = new SqliteNotificationOutbox(".shopcall/notifications.sqlite");
// Supply outbox to enqueuePublicationReadyEmail/processNotificationOutbox/
// refreshNotificationDeliveryStatus. Parent worker owns lifecycle/config/auth.
// Close at worker shutdown:
outbox.close();
```

## Guarantees

- SQLite file, WAL and shared-memory sidecars use mode 0600. The containing directory must be private (0700); a new containing directory is created with that mode. Existing shared directories and symlink DB files are rejected. Store rendered email/recipient data as private operational state, never in source control or logs.
- WAL mode, `synchronous=FULL`, and five-second busy timeout. Multiple workers on the same host can open the same file. This is not a cross-host or network-filesystem queue.
- `enqueue` uses a unique dedupe key and immediate transaction. A duplicate returns the original immutable payload and idempotency key even if the caller now supplies different content. Provider idempotency keys are also unique across records.
- `claimDue` selects eligible pending rows, assigns fresh token/expiry, increments attempts, and persists first-attempt timestamp in the same immediate transaction before returning. A restarted worker sees persisted attempts and leases.
- `completeClaim` is an atomic compare-and-set: pending row, matching nonempty token and **unexpired** lease are all required. It clears lease and applies the patch in one update. An expired or replaced token returns false; callers must treat this as lost ownership, not success.
- `update` is for unleased status/poll updates; it cannot mutate a currently leased row. Terminal states (`delivered`, `delivery_failed`, `send_failed`, `cancelled`) are preserved against stale polls. A status view must read persisted state rather than assume an update occurred. Claims whose expiry equals the exact current millisecond are not reclaimed until the next millisecond, matching the existing repository's strict `< now` eligibility.
- Runtime schemas allow only known input/patch fields, normalize timestamp offsets to UTC ISO, and reject invalid limits/durations/dates. No SQL fragments derive from caller data; patch columns come from a strict allowlist.

## Deployment limits

Use a persistent private local volume and a durable worker process. Do not place this DB on ephemeral serverless filesystems, autoscaling replica-local disks, or NFS/shared-network mounts. Each replica opening a separate copy would create independent queues and could duplicate sends. If deployment needs multiple hosts, B should implement the same interface over a shared transactional database instead.

There is no automatic deletion policy for stored mail bodies/recipient PII yet. Decide retention separately; ordinary catalog cleanup must not delete the outbox while unknown provider outcomes can still be retried.

Storage does not send email or establish publication verification. It preserves the existing notification service's verification gate, payload and provider idempotency key. The publication adapter must load owner email and verification evidence from canonical server-side sources.

## Validation

Six tests in `tests/integrations/notifications-sqlite.test.ts` passed locally:

- Cross-connection and restart dedupe preserves original payload/key.
- Crashed/restarted lease is recovered with persisted attempts; expired/stale tokens cannot finish.
- Retry schedule and terminal delivery evidence persist and cannot regress under stale polling.
- Timestamp offsets normalize; invalid input cannot alter queued data.
- DB/sidecars remain private; symlink/shared-directory storage is refused.
- Two independent OS processes race enqueue and claims against one file without duplicate rows or claims.

No real notification was sent and no provider key was used during these tests.

## Existing service review notes

The current notification processor checks `maxAttempts` after a retryable provider outcome, rather than immediately before a send. If a worker crashes after its final claimed attempt, lease recovery can result in another send attempt. Stable idempotency keys and the retry window still constrain duplicate-delivery risk, but a strict attempt cap requires a pre-send guard in the service.

The current processor includes `err.message` from publication-source exceptions in stored errors. The publication adapter should expose safe error messages; do not let credential-bearing upstream exception text reach that boundary.

Primary references: [better-sqlite3 transactions](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md), [SQLite WAL deployment constraints](https://www.sqlite.org/wal.html).
