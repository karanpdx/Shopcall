import test from "node:test";
import assert from "node:assert/strict";
import {
  createInMemoryNotificationOutbox,
  createResendClient,
  enqueuePublicationReadyEmail,
  escapeHtml,
  getNotificationHealth,
  getPublicationNotificationStatus,
  loadNotificationConfig,
  processNotificationOutbox,
  refreshNotificationDeliveryStatus,
  renderPublicationReadyEmail,
  validatePublicUrl,
  type VerifiedPublicationSource,
} from "../../src/integrations/notifications";

// All provider traffic is mocked. No real email is sent.

const API_KEY = "re_test_key_should_never_leak";
const JOB = "0b8f3c1e-2f1d-4c7a-9a55-5b5f0a6a9e11";
const URL_OK = "https://shop-demo.replit.app/";

function verified(overrides: Record<string, unknown> = {}) {
  return {
    jobId: JOB,
    businessId: "7d1f2f4a-0c1e-4b8e-9b0a-1b2c3d4e5f60",
    businessName: "Kim's <Pottery> & \"Mugs\"",
    ownerEmail: "owner@example.com",
    phase: "ready",
    publicUrl: URL_OK,
    catalogRevision: 3,
    verification: {
      verifiedAt: "2026-11-20T10:00:00.000Z",
      verifiedUrl: URL_OK,
      httpStatus: 200,
      businessIdMatched: true,
      catalogRevisionMatched: true,
    },
    ...overrides,
  };
}

function source(value: () => unknown): VerifiedPublicationSource {
  return { getPublication: async () => value() };
}

type Call = { url: string; init: RequestInit };
function mockFetch(responses: Array<Response | Error | (() => Response)>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { fn, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function clockAt(iso: string) {
  let t = Date.parse(iso);
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}

function setup(pub: () => unknown, responses: Parameters<typeof mockFetch>[0]) {
  const outbox = createInMemoryNotificationOutbox();
  const clock = clockAt("2026-11-20T10:05:00.000Z");
  const http = mockFetch(responses);
  const resend = createResendClient({ apiKey: API_KEY, fetch: http.fn });
  const publications = source(pub);
  const deps = { outbox, publications, resend, clock: clock.now, sender: { from: "Shopcall <notify@shopcall.dev>" } };
  return { outbox, clock, http, deps };
}

// ---------- verification gate ----------

test("rejects unverified, failed, or incomplete publications and enqueues nothing", async () => {
  const cases: Array<[unknown, string]> = [
    [null, "NOT_FOUND"],
    [verified({ phase: "failed" }), "NOT_VERIFIED"],
    [verified({ phase: "publishing" }), "NOT_VERIFIED"],
    [verified({ verification: { ...verified().verification, httpStatus: 503 } }), "NOT_VERIFIED"],
    [verified({ verification: { ...verified().verification, businessIdMatched: false } }), "NOT_VERIFIED"],
    [verified({ verification: { ...verified().verification, catalogRevisionMatched: false } }), "NOT_VERIFIED"],
    [verified({ verification: { ...verified().verification, verifiedUrl: "https://other.replit.app/" } }), "NOT_VERIFIED"],
    [verified({ verification: undefined }), "NOT_VERIFIED"],
    [verified({ publicUrl: "http://shop-demo.replit.app/", verification: { ...verified().verification, verifiedUrl: "http://shop-demo.replit.app/" } }), "INVALID_URL"],
    [verified({ ownerEmail: "owner@example.com\r\nBcc: x@evil.test" }), "INVALID_RECIPIENT"],
    [verified({ jobId: "other-job" }), "INVALID_PUBLICATION"],
  ];
  for (const [pub, code] of cases) {
    const { outbox, deps, http } = setup(() => pub, []);
    const res = await enqueuePublicationReadyEmail(deps, { jobId: JOB });
    assert.equal(res.ok, false, `expected rejection for ${code}`);
    if (!res.ok) assert.equal(res.error.code, code);
    assert.equal(outbox.all().length, 0);
    assert.equal(http.calls.length, 0);
  }
});

test("enqueue is idempotent per job+revision", async () => {
  const { outbox, deps } = setup(() => verified(), []);
  const a = await enqueuePublicationReadyEmail(deps, { jobId: JOB });
  const b = await enqueuePublicationReadyEmail(deps, { jobId: JOB });
  assert.ok(a.ok && b.ok);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(outbox.all().length, 1);
});

test("cancels without sending when publication is no longer verified at send time", async () => {
  let pub: unknown = verified();
  const { outbox, deps, http } = setup(() => pub, []);
  await enqueuePublicationReadyEmail(deps, { jobId: JOB });
  pub = verified({ phase: "failed" });
  const summary = await processNotificationOutbox(deps);
  assert.equal(summary.cancelled, 1);
  assert.equal(http.calls.length, 0);
  assert.equal(outbox.all()[0].status, "cancelled");
});

test("cancels when URL changed between enqueue and send", async () => {
  let pub: unknown = verified();
  const { outbox, deps, http } = setup(() => pub, []);
  await enqueuePublicationReadyEmail(deps, { jobId: JOB });
  const moved = "https://moved.replit.app/";
  pub = verified({ publicUrl: moved, verification: { ...verified().verification, verifiedUrl: moved } });
  await processNotificationOutbox(deps);
  assert.equal(http.calls.length, 0);
  assert.equal(outbox.all()[0].status, "cancelled");
});

test("owner email changes cancel stored recipient rather than sending stale owner address", async () => {
  let pub: unknown = verified();
  const { outbox, deps, http } = setup(() => pub, []);
  await enqueuePublicationReadyEmail(deps, { jobId: JOB });
  pub = verified({ ownerEmail: "new-owner@example.com" });
  assert.equal((await processNotificationOutbox(deps)).cancelled, 1);
  assert.equal(http.calls.length, 0);
  assert.equal(outbox.all()[0].status, "cancelled");
});

// ---------- escaping / URL ----------

test("escapes merchant content and validates URLs", () => {
  assert.equal(escapeHtml(`<script>"x"&'y'</script>`), "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;");
  const r = renderPublicationReadyEmail({ businessName: "<img src=x onerror=alert(1)>\r\nBcc: a@b.c", publicUrl: URL_OK, catalogRevision: 1 });
  assert.ok(!r.html.includes("<img"));
  assert.ok(r.html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(!/[\r\n]/.test(r.subject));

  for (const bad of [
    "javascript:alert(1)", "http://shop.replit.app", "https://user:pw@shop.replit.app", "https://localhost/",
    "https://127.0.0.1/", "https://[::1]/", "https://intranet/", "https://shop.replit.app/\"><script>", "data:text/html,x", "",
  ]) assert.equal(validatePublicUrl(bad), null, bad);
  assert.equal(validatePublicUrl("https://shop.replit.app/store?id=1"), "https://shop.replit.app/store?id=1");
  assert.throws(() => renderPublicationReadyEmail({ businessName: "x", publicUrl: "javascript:alert(1)", catalogRevision: 1 }));
});

// ---------- send: request shape, accepted vs delivered ----------

test("sends via Resend with stable idempotency key; accepted is not delivered", async () => {
  const { outbox, deps, http } = setup(() => verified(), [json(200, { id: "email_123" })]);
  await enqueuePublicationReadyEmail(deps, { jobId: JOB });
  const summary = await processNotificationOutbox(deps);
  assert.equal(summary.accepted, 1);

  const call = http.calls[0];
  assert.equal(call.url, "https://api.resend.com/emails");
  assert.equal(call.init.method, "POST");
  const h = call.init.headers as Record<string, string>;
  assert.equal(h.Authorization, `Bearer ${API_KEY}`);
  assert.equal(h["Idempotency-Key"], `shopcall/publication-ready/${JOB}/3`);
  assert.ok(h["User-Agent"]);
  const body = JSON.parse(String(call.init.body));
  assert.deepEqual(body.to, ["owner@example.com"]);
  assert.equal(body.from, "Shopcall <notify@shopcall.dev>");
  assert.ok(body.html.includes("Kim&#39;s &lt;Pottery&gt; &amp; &quot;Mugs&quot;"));
  for (const t of body.tags) assert.match(t.value, /^[A-Za-z0-9_-]+$/);

  const rec = outbox.all()[0];
  assert.equal(rec.status, "accepted");
  assert.equal(rec.providerMessageId, "email_123");
  assert.equal(rec.deliveredAt, null);
  const view = await getPublicationNotificationStatus(outbox, JOB);
  assert.equal(view.status, "accepted");
  assert.ok(!JSON.stringify(view).includes("owner@example.com"));
});

test("delivery polling distinguishes sent, delivered and bounced", async () => {
  const { outbox, deps, http } = setup(() => verified(), [
    json(200, { id: "email_123" }),
    json(200, { id: "email_123", last_event: "sent" }),
    json(200, { id: "email_123", last_event: "delivered" }),
  ]);
  await enqueuePublicationReadyEmail(deps, { jobId: JOB });
  await processNotificationOutbox(deps);

  let r = await refreshNotificationDeliveryStatus(deps);
  assert.equal(r.unchanged, 1);
  assert.equal(outbox.all()[0].status, "accepted");
  assert.equal(outbox.all()[0].providerLastEvent, "sent");
  assert.equal(http.calls[1].url, "https://api.resend.com/emails/email_123");

  r = await refreshNotificationDeliveryStatus(deps);
  assert.equal(r.delivered, 1);
  assert.equal(outbox.all()[0].status, "delivered");
  assert.ok(outbox.all()[0].deliveredAt);

  const b = setup(() => verified(), [json(200, { id: "e2" }), json(200, { last_event: "bounced" })]);
  await enqueuePublicationReadyEmail(b.deps, { jobId: JOB });
  await processNotificationOutbox(b.deps);
  await refreshNotificationDeliveryStatus(b.deps);
  assert.equal(b.outbox.all()[0].status, "delivery_failed");
});

// ---------- retries / failures ----------

test("network timeout then 5xx then success retries with the same key and payload", async () => {
  const { outbox, deps, http, clock } = setup(() => verified(), [
    new DOMException("The operation timed out.", "TimeoutError"),
    json(503, { name: "service_unavailable", message: "try later" }),
    json(200, { id: "email_ok" }),
  ]);
  await enqueuePublicationReadyEmail(deps, { jobId: JOB });

  let s = await processNotificationOutbox(deps);
  assert.equal(s.retrying, 1);
  assert.equal(outbox.all()[0].status, "pending");
  // Not due yet: nothing claimed.
  s = await processNotificationOutbox(deps);
  assert.equal(s.claimed, 0);

  clock.advance(30_000);
  s = await processNotificationOutbox(deps);
  assert.equal(s.retrying, 1);
  clock.advance(60_000);
  s = await processNotificationOutbox(deps);
  assert.equal(s.accepted, 1);

  assert.equal(http.calls.length, 3);
  const keys = http.calls.map(c => (c.init.headers as Record<string, string>)["Idempotency-Key"]);
  assert.equal(new Set(keys).size, 1);
  assert.equal(new Set(http.calls.map(c => c.init.body)).size, 1);
  assert.equal(outbox.all()[0].attempts, 3);
});

test("429 rate limit honors retry-after", async () => {
  const { outbox, deps } = setup(() => verified(), [json(429, { name: "rate_limit_exceeded", message: "slow" }, { "retry-after": "120" })]);
  await enqueuePublicationReadyEmail(deps, { jobId: JOB });
  await processNotificationOutbox(deps);
  const rec = outbox.all()[0];
  assert.equal(rec.status, "pending");
  assert.equal(Date.parse(rec.nextAttemptAt) - Date.parse("2026-11-20T10:05:00.000Z"), 120_000);
});

test("permanent provider errors fail visibly without retry", async () => {
  for (const [status, name] of [
    [403, "validation_error"], [401, "missing_api_key"], [422, "invalid_parameter"],
    [409, "invalid_idempotent_request"], [429, "monthly_quota_exceeded"],
  ] as const) {
    const { outbox, deps, http, clock } = setup(() => verified(), [json(status, { name, message: `m ${API_KEY}` })]);
    await enqueuePublicationReadyEmail(deps, { jobId: JOB });
    const s = await processNotificationOutbox(deps);
    assert.equal(s.sendFailed, 1, name);
    const rec = outbox.all()[0];
    assert.equal(rec.status, "send_failed");
    assert.ok(rec.lastError?.includes(name));
    assert.ok(!rec.lastError?.includes(API_KEY), "api key must be redacted");
    clock.advance(24 * 3600_000);
    await processNotificationOutbox(deps);
    assert.equal(http.calls.length, 1);
  }
});

test("409 concurrent_idempotent_requests is retryable", async () => {
  const { outbox, deps } = setup(() => verified(), [json(409, { name: "concurrent_idempotent_requests", message: "busy" })]);
  await enqueuePublicationReadyEmail(deps, { jobId: JOB });
  await processNotificationOutbox(deps);
  assert.equal(outbox.all()[0].status, "pending");
});

test("retries exhaust into send_failed", async () => {
  const fails = Array.from({ length: 3 }, () => () => json(500, { name: "application_error", message: "boom" }));
  const { outbox, deps, clock, http } = setup(() => verified(), fails);
  const d = { ...deps, retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 1000 } };
  await enqueuePublicationReadyEmail(d, { jobId: JOB });
  for (let i = 0; i < 5; i++) { await processNotificationOutbox(d); clock.advance(2000); }
  assert.equal(http.calls.length, 3);
  const rec = outbox.all()[0];
  assert.equal(rec.status, "send_failed");
  assert.match(rec.lastError ?? "", /retries exhausted/);
  assert.equal((await getPublicationNotificationStatus(outbox, JOB)).status, "send_failed");
});

test("2xx without id is treated as unknown outcome and retried", async () => {
  const { outbox, deps } = setup(() => verified(), [json(200, {})]);
  await enqueuePublicationReadyEmail(deps, { jobId: JOB });
  await processNotificationOutbox(deps);
  assert.equal(outbox.all()[0].status, "pending");
});

test("stops retrying past the provider idempotency window", async () => {
  const { outbox, deps, clock, http } = setup(() => verified(), [new Error("ECONNRESET")]);
  const d = { ...deps, retry: { maxAttempts: 10 } };
  await enqueuePublicationReadyEmail(d, { jobId: JOB });
  await processNotificationOutbox(d);
  clock.advance(24 * 3600_000);
  await processNotificationOutbox(d);
  assert.equal(http.calls.length, 1);
  assert.equal(outbox.all()[0].status, "send_failed");
  assert.match(outbox.all()[0].lastError ?? "", /idempotency/);
});

test("publication source outage does not send and retries later", async () => {
  let down = true;
  const { outbox, deps, http } = setup(() => { if (down) throw new Error("db down secret=NEVER_STORE"); return verified(); }, []);
  // Enqueue while source is up.
  down = false;
  await enqueuePublicationReadyEmail(deps, { jobId: JOB });
  down = true;
  await processNotificationOutbox(deps);
  assert.equal(http.calls.length, 0);
  assert.equal(outbox.all()[0].status, "pending");
  assert.equal(outbox.all()[0].lastError?.includes("NEVER_STORE"), false);
});

test("crashed final send lease cannot bypass maximum attempt budget", async () => {
  const { outbox, deps, http, clock } = setup(() => verified(), []);
  await enqueuePublicationReadyEmail({ ...deps, retry: { maxAttempts: 1 } }, { jobId: JOB });
  await outbox.claimDue(clock.now(), 1, 1000);
  clock.advance(1001);
  assert.equal((await processNotificationOutbox(deps)).sendFailed, 1);
  assert.equal(http.calls.length, 0);
  assert.equal(outbox.all()[0].status, "send_failed");
});

test("concurrent workers do not double-send a leased record", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const { deps, http } = setup(() => verified(), []);
  const slow = { ...deps, resend: { ...deps.resend, sendEmail: async () => { http.calls.push({ url: "x", init: {} }); await gate; return { kind: "accepted" as const, id: "e" }; } } };
  await enqueuePublicationReadyEmail(slow, { jobId: JOB });
  const first = processNotificationOutbox(slow);
  await new Promise(r => setImmediate(r));
  const second = await processNotificationOutbox(slow);
  assert.equal(second.claimed, 0);
  release();
  assert.equal((await first).accepted, 1);
  assert.equal(http.calls.length, 1);
});

// ---------- config ----------

test("config health reports names only, never values", () => {
  const h = getNotificationHealth({ RESEND_API_KEY: API_KEY });
  assert.deepEqual(h, { configured: false, missing: ["EMAIL_FROM"] });
  assert.ok(!JSON.stringify(h).includes(API_KEY));
  assert.throws(() => loadNotificationConfig({}), /RESEND_API_KEY, EMAIL_FROM/);
  assert.throws(() => loadNotificationConfig({ RESEND_API_KEY: "k", EMAIL_FROM: "bad\r\nBcc: x@y.z" }));
  assert.equal(loadNotificationConfig({ RESEND_API_KEY: "k", EMAIL_FROM: "Shopcall <a@b.co>" }).from, "Shopcall <a@b.co>");
});
