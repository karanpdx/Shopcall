import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { body, bracelet, call, createAndApprove, params, signIn } from "./helpers/backend";
import * as catalog from "../src/app/api/public/[slug]/catalog/route";
import * as uploads from "../src/app/api/uploads/route";
import { publicCatalogUrl } from "../src/server/config";

const fetchCatalog = (slug: string) => catalog.GET(call("GET", `/api/public/${slug}/catalog`), params({ slug }));

test("anonymous catalog: published products only, live updates, no private data", async () => {
  const { cookie, session } = await signIn();
  const form = new FormData();
  form.set("file", new Blob([await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000" } }).png().toBuffer() as BlobPart], { type: "image/png" }), "p.png");
  const asset = (await body(await uploads.POST(call("POST", "/api/uploads", { cookie, raw: form })))).data;

  const shown = await createAndApprove(cookie, { type: "create_product", product: { ...bracelet, imageAssetId: asset.id } });
  const hidden = await createAndApprove(cookie, { type: "create_product", product: { ...bracelet, name: "Secret prototype" } });
  await createAndApprove(cookie, { type: "update_product", productId: hidden.data.product.id, patch: { isPublished: false }, expectedRevision: 1 });
  await createAndApprove(cookie, { type: "update_storefront", patch: { contactEmail: "hello@clayco.example" } });
  // A pending draft must not leak.
  const { POST } = await import("../src/app/api/drafts/route");
  await POST(call("POST", "/api/drafts", { cookie, body: { type: "update_price", productId: shown.data.product.id, priceCents: 1, expectedRevision: 1 } }));

  const res = await fetchCatalog("clay-co");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("access-control-allow-credentials"), null);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const c = (await body(res)).data;
  assert.equal(c.business.name, "Clay & Co");
  assert.equal(c.business.contactEmail, "hello@clayco.example");
  assert.deepEqual(c.products.map((p: any) => p.name), ["Beaded bracelet"]);
  assert.equal(c.products[0].imageUrl, `https://api.shopcall.test/api/assets/${asset.id}`);
  assert.deepEqual(Object.keys(c.products[0]).sort(), ["category", "description", "id", "imageUrl", "inventoryCount", "isFeatured", "name", "priceCents", "revision", "soldOut", "updatedAt"]);

  const raw = JSON.stringify(c);
  for (const secret of [session.owner.id, session.business.id, session.owner.email, "storage", "originals", "draft", "Secret prototype", "pending"]) {
    assert.equal(raw.includes(secret), false, `leaked ${secret}`);
  }

  // Same URL reflects the approved change with no rebuild.
  const rev = c.catalogRevision;
  await createAndApprove(cookie, { type: "update_price", productId: shown.data.product.id, priceCents: 3000, expectedRevision: 1 });
  await createAndApprove(cookie, { type: "adjust_stock", productId: shown.data.product.id, delta: -3, expectedRevision: 2 });
  const after = (await body(await fetchCatalog("clay-co"))).data;
  assert.equal(after.products[0].priceCents, 3000);
  assert.equal(after.products[0].inventoryCount, 7);
  assert.equal(after.catalogRevision, rev + 2);
});

test("business scoping and unknown slug", async () => {
  const { cookie } = await signIn("other@shop.example", "Other Shop");
  await createAndApprove(cookie, { type: "create_product", product: { ...bracelet, name: "Other thing" } });
  const other = (await body(await fetchCatalog("other-shop"))).data;
  assert.deepEqual(other.products.map((p: any) => p.name), ["Other thing"]);
  assert.equal((await fetchCatalog("no-such-store")).status, 404);
  assert.equal((await catalog.OPTIONS()).status, 204);
});

test("public catalog URL requires a configured, non-loopback https origin in production", () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = { base: env.PUBLIC_API_BASE, node: env.NODE_ENV };
  try {
    assert.equal(publicCatalogUrl("clay-co"), "https://api.shopcall.test/api/public/clay-co/catalog");
    delete env.PUBLIC_API_BASE;
    assert.throws(() => publicCatalogUrl("x"), /PUBLIC_API_BASE is not configured/);
    env.NODE_ENV = "production";
    env.PUBLIC_API_BASE = "http://api.shopcall.test";
    assert.throws(() => publicCatalogUrl("x"), /https/);
    env.PUBLIC_API_BASE = "https://localhost:3000";
    assert.throws(() => publicCatalogUrl("x"), /loopback/);
  } finally {
    env.PUBLIC_API_BASE = saved.base;
    env.NODE_ENV = saved.node;
  }
});

test("catalog returns 503 rather than relative image URLs when PUBLIC_API_BASE is missing", async () => {
  const saved = process.env.PUBLIC_API_BASE;
  delete process.env.PUBLIC_API_BASE;
  try {
    const res = await fetchCatalog("clay-co");
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  } finally {
    process.env.PUBLIC_API_BASE = saved;
  }
});
