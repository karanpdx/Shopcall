# Notifications handoff — publication-ready email (Resend)

Owner: Person C. Files: `src/integrations/notifications/**`, `tests/integrations/notifications.test.ts`.

## Status (be precise)

| Item | State |
|---|---|
| Adapter, outbox state machine, Resend REST client | **Implemented** |
| Mocked contract tests (verification gate, escaping, URL, idempotency, retries, provider failures, lease) | **Tested locally** (17 tests, mocked `fetch`) |
| Real Resend send / delivery | **Not provider-verified.** No real email sent. Needs verified sender domain + key. |
| Durable outbox (DB) | **Not implemented.** Only in-memory impl exists (tests/dev). Storage owner must implement `NotificationOutboxRepository`. |
| API route / worker wiring | **Not implemented** (B owns routes; worker script not wired). |
| Deployed | No. |

`npm test` runs `tests/*.test.ts` only — it does **not** pick up `tests/integrations/`. Run explicitly:

```bash
npx tsx --test tests/integrations/notifications.test.ts
```

Root-script change (`"test": "tsx --test tests/*.test.ts tests/integrations/*.test.ts"`) needs package.json coordination; not done here.

## Environment

| Name | Required | Use |
|---|---|---|
| `RESEND_API_KEY` | yes | Server-only bearer token. Never log/return. |
| `EMAIL_FROM` | yes | `Name <addr@verified-domain>`; domain must be verified in Resend. |
| `EMAIL_REPLY_TO` | no | Optional reply-to address. |

Recipient is **not** an env var: it is `ownerEmail` returned by the trusted publication source (for the single demo merchant B may return `DEMO_OWNER_EMAIL`, bound to the business server-side). `EMAIL_REPLY_TO` is new and not yet in `.env.example` (shared file — C to add in a root-config PR).

## Exports (`@/integrations/notifications`)

Server-only. Never import from client components.

| Export | Signature / purpose |
|---|---|
| `getNotificationHealth(env?)` | `{ configured, missing: string[] }` — names only, no values. Safe for health route. |
| `loadNotificationConfig(env?)` | `NotificationConfig { resendApiKey, from, replyTo?, resendBaseUrl }`; throws if missing/invalid. |
| `createResendClient({ apiKey, baseUrl?, fetch?, timeoutMs? })` | `ResendClient` with `sendEmail(payload, idempotencyKey)` → `accepted \| retryable \| permanent`, `getEmailLastEvent(id)`. Built-in `fetch`, 10s timeout, API key redacted from errors. |
| `enqueuePublicationReadyEmail(deps, { jobId })` | Loads publication from **trusted source**, enforces verification, renders + stores payload in outbox. Idempotent per `jobId+catalogRevision`. Sends nothing. Returns `EnqueueResult`. |
| `processNotificationOutbox(deps, { limit? })` | Worker step. Claims due rows (lease), **re-checks verification**, sends with stable `Idempotency-Key`, sets `accepted` / retry / `send_failed` / `cancelled`. Returns `ProcessSummary`. |
| `refreshNotificationDeliveryStatus(deps, { limit? })` | Polls `GET /emails/{id}`; `delivered/opened/clicked/complained` → `delivered`; `bounced/failed/suppressed/canceled` → `delivery_failed`; else stays `accepted`. |
| `getPublicationNotificationStatus(outbox, jobId)` | Owner-UI projection `{ status \| "none", attempts, errorCode, providerLastEvent, acceptedAt, deliveredAt, nextAttemptAt, catalogRevision }`. `errorCode` ∈ `RETRYING \| SEND_FAILED \| DELIVERY_FAILED \| PUBLICATION_NOT_VERIFIED`. No recipient, body, or raw error text (raw `lastError` stays in the outbox for operators). |
| `createInMemoryNotificationOutbox()` | Test/dev outbox. **Not durable.** |
| `renderPublicationReadyEmail`, `escapeHtml`, `validatePublicUrl` | Pure helpers. |
| `DEFAULT_RETRY_POLICY` | 6 attempts, 30s→30min exp backoff, 23h retry window, 60s lease. |
| Types | `VerifiedPublication`, `VerifiedPublicationSource`, `NotificationOutboxRepository`, `OutboxRecord`, `NotificationStatus`, `EnqueueResult`, … |

`deps` shapes:

```ts
enqueue:  { outbox, publications, sender: { from, replyTo? }, clock?, retry? }
process:  { outbox, publications, resend, clock?, retry? }
refresh:  { outbox, resend, clock? }
```

## Trust model

- Input is only `jobId`. All facts come from `VerifiedPublicationSource.getPublication(jobId)`, implemented server-side over the job store. Never pass request bodies or model/tool output into it.
- Accepted only when: `phase === "ready"`, `verification.httpStatus` 2xx, `businessIdMatched === true`, `catalogRevisionMatched === true`, `verifiedAt` ISO, `verifiedUrl` normalizes to `publicUrl`, URL is public `https` (no creds, IP, localhost, `.local/.internal`), `ownerEmail` valid (no CR/LF).
- Checked at enqueue **and again right before send**; if no longer verified or URL/revision changed → `cancelled`, nothing sent.
- Merchant `businessName` is HTML-escaped in body, control chars stripped from subject. URL escaped in `href`.

## State semantics (for status UI)

`pending` (queued/retrying) → `accepted` (Resend took it; **not** delivered) → `delivered` | `delivery_failed`. Terminal failures: `send_failed` (permanent error or retries exhausted), `cancelled` (publication not verified at send time). UI must not show "email delivered" for `accepted`.

Provider error mapping: retryable = network/timeout, 5xx, 2xx-without-id, `429 rate_limit_exceeded` (honors `retry-after`), `409 concurrent_idempotent_requests` / `resource_locked`. Permanent = other 4xx incl. `409 invalid_idempotent_request`, `429 daily/monthly_quota_exceeded`, auth/validation/unverified-domain `403`.

Duplicate-send protection: `Idempotency-Key = shopcall/publication-ready/<jobId>/<revision>`, identical payload stored at enqueue. Resend keeps keys 24h, so retries stop after 23h (`send_failed`, outcome-unknown message) rather than risk a duplicate.

## Wiring for Codex

1. **Storage owner (B):** implement `NotificationOutboxRepository` on the app DB. Required semantics are in the JSDoc in `types.ts` (unique `dedupeKey`; atomic `claimDue` that increments `attempts`, sets `firstAttemptAt`, lease token/expiry; `completeClaim` conditional on lease token). Suggested table `notification_outbox` with columns matching `OutboxRecord` (`payload` JSON), unique index on `dedupe_key`, index on `(status, next_attempt_at)`.
2. **Publication source (B/C worker):** implement `VerifiedPublicationSource.getPublication(jobId)` returning `VerifiedPublication` from the persisted `BuildJob` + verifier evidence + owner email for `businessId`. Return the job even when not ready (gate rejects it) or `null` if unknown. `BuildJob` in `src/contracts/integrations.ts` currently lacks verification evidence fields — contract extension coordinated by B.
3. **Publication worker (C):** after anonymous verification marks job `ready`, call `enqueuePublicationReadyEmail({ outbox, publications, sender: loadNotificationConfig() }, { jobId })`.
4. **Worker loop (`scripts/worker.ts`, C):**
   ```ts
   const cfg = loadNotificationConfig();
   const resend = createResendClient({ apiKey: cfg.resendApiKey });
   await processNotificationOutbox({ outbox, publications, resend });
   await refreshNotificationDeliveryStatus({ outbox, resend });
   ```
   Run every ~15–30s. Safe to run concurrently (leases).
5. **B route `GET /api/jobs/:id`:** include `notification: await getPublicationNotificationStatus(outbox, jobId)` after owner authorization.
6. **Health:** `getNotificationHealth()` in health route if desired (names only).

No webhook added. A Resend webhook would require Svix signature verification; polling avoids that for now.

## Setup gates before claiming real email works

- Verified sending domain in Resend for `EMAIL_FROM`; key in `.env.local` (never committed or printed).
- One real send to the demo owner after a real verified publication; record provider message id and observed `last_event` separately from mocked tests.
