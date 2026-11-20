import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createPublicCatalogProxy } from "../../scripts/public-catalog-proxy";

const asset = "f1fa84f0-c846-48ba-9cad-7bf073e906fb";
async function fixture(t: { after(fn: () => Promise<void>): void }, upstream: typeof fetch) {
  const server = createPublicCatalogProxy(upstream);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("only exact public catalog/assets GET and HEAD routes reach fixed localhost", async t => {
  const calls: string[] = [];
  const origin = await fixture(t, (async input => { calls.push(String(input)); return Response.json({ ok: true }); }) as typeof fetch);
  for (const [path, method] of [["/", "GET"], ["/api/session", "GET"], ["/api/auth/login", "POST"], ["/api/public/demo/catalog", "POST"], ["/api/public/demo/catalog?redirect=https://attacker.example", "GET"], ["/api/assets/not-uuid", "GET"], ["/api/public/demo%2f..%2fauth/catalog", "GET"]]) {
    assert.equal((await fetch(`${origin}${path}`, { method })).status, 404);
  }
  assert.equal(calls.length, 0);
  assert.equal((await fetch(`${origin}/api/public/demo-store/catalog`)).status, 200);
  assert.deepEqual(calls, ["http://127.0.0.1:3000/api/public/demo-store/catalog"]);
});

test("caller credentials and upstream cookies/hop headers never cross proxy; catalog remains no-store", async t => {
  const origin = await fixture(t, (async (_url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("host"), null);
    assert.equal(headers.get("x-forwarded-host"), null);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "manual");
    return Response.json({ business: { name: "Public studio" } }, { headers: { "set-cookie": "private=secret", "x-private-token": "secret", "cache-control": "public, max-age=86400", "access-control-allow-credentials": "true" } });
  }) as typeof fetch);
  const response = await fetch(`${origin}/api/public/demo/catalog`, { headers: { Cookie: "owner-session=secret", Authorization: "Bearer secret", "X-Forwarded-Host": "attacker.example" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-private-token"), null);
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("images retain safe bytes; private assets stay inaccessible; HEAD never returns body", async t => {
  let method: string | undefined;
  const origin = await fixture(t, (async (_url, init) => { method = init?.method; return new Response(init?.method === "HEAD" ? null : new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=3600" } }); }) as typeof fetch);
  const image = await fetch(`${origin}/api/assets/${asset}`);
  assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [1, 2, 3]);
  const head = await fetch(`${origin}/api/assets/${asset}`, { method: "HEAD" });
  assert.equal(method, "HEAD");
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("content-type"), "image/jpeg");
});

test("redirects, upstream errors, unsafe MIME and oversized JSON fail without upstream debug details", async t => {
  const cases = [
    () => new Response(null, { status: 302, headers: { location: "http://localhost/admin", "set-cookie": "secret" } }),
    () => new Response("private-stack-and-secrets", { status: 500 }),
    () => new Response("<html>private app</html>", { headers: { "content-type": "text/html" } }),
    () => new Response("x".repeat(2_000_001), { headers: { "content-type": "application/json" } }),
  ];
  for (const response of cases) {
    const origin = await fixture(t, (async () => response()) as typeof fetch);
    const actual = await fetch(`${origin}/api/public/demo/catalog`);
    assert.equal(actual.status, 502);
    assert.equal(await actual.text(), "Public data unavailable.");
    assert.equal(actual.headers.get("location"), null);
  }
});

test("private asset upstream 404 cannot be bypassed by sending owner cookies", async t => {
  const origin = await fixture(t, (async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("cookie"), null);
    return new Response("private draft details must not pass through", { status: 404 });
  }) as typeof fetch);
  const response = await fetch(`${origin}/api/assets/${asset}`, { headers: { Cookie: "owner-session=secret" } });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found.");
});
