import test from "node:test";
import assert from "node:assert/strict";
import { body, bracelet, call, createAndApprove, params, signIn } from "./helpers/backend";
import * as drafts from "../src/app/api/drafts/route";
import * as draftById from "../src/app/api/drafts/[id]/route";
import * as approve from "../src/app/api/drafts/[id]/approve/route";
import * as reject from "../src/app/api/drafts/[id]/reject/route";
import * as products from "../src/app/api/products/route";
import * as productById from "../src/app/api/products/[id]/route";
import * as session from "../src/app/api/session/route";
import * as business from "../src/app/api/business/route";
import * as login from "../src/app/api/auth/login/route";
import * as logout from "../src/app/api/auth/logout/route";

const getProduct = async (cookie: string, id: string) =>
  body(await productById.GET(call("GET", `/api/products/${id}`, { cookie }), params({ id })));

test("auth: session, wrong password, missing cookie, cross-origin, logout", async () => {
  const { cookie, session: s } = await signIn();
  assert.equal(s.owner.email, "owner@ceramics.example");
  assert.equal(s.business.slug, "clay-co");

  const me = await body(await session.GET(call("GET", "/api/session", { cookie })));
  assert.equal(me.data.business.id, s.business.id);
  const biz = await body(await business.GET(call("GET", "/api/business", { cookie })));
  assert.equal(biz.data.publicCatalogUrl, "https://api.shopcall.test/api/public/clay-co/catalog");

  const bad = await login.POST(call("POST", "/api/auth/login", { body: { email: "owner@ceramics.example", password: "nope" } }));
  assert.equal(bad.status, 401);
  assert.equal((await session.GET(call("GET", "/api/session"))).status, 401);
  assert.equal((await session.GET(call("GET", "/api/session", { cookie: "shopcall_session=forged" }))).status, 401);

  const csrf = await drafts.POST(call("POST", "/api/drafts", { cookie, origin: "https://evil.example", body: { type: "create_product", product: bracelet } }));
  assert.equal(csrf.status, 403);

  const { cookie: c2 } = await signIn();
  await logout.POST(call("POST", "/api/auth/logout", { cookie: c2 }));
  assert.equal((await session.GET(call("GET", "/api/session", { cookie: c2 }))).status, 401);
});

test("create product draft → approve → persisted and listed", async () => {
  const { cookie } = await signIn();
  const created = await body(await drafts.POST(call("POST", "/api/drafts", { cookie, body: { type: "create_product", product: bracelet } })));
  assert.equal(created.data.status, "pending");
  assert.equal(created.data.targetId, null);
  assert.deepEqual(created.data.proposedValues, { type: "create_product", product: bracelet });

  // Pending draft does not create anything.
  const before = (await body(await products.GET(call("GET", "/api/products", { cookie })))).data.length;

  const res = await body(await approve.POST(call("POST", `/api/drafts/${created.data.id}/approve`, { cookie }), params({ id: created.data.id })));
  assert.equal(res.ok, true);
  assert.equal(res.data.draft.status, "approved");
  assert.equal(res.data.draft.targetId, res.data.product.id);
  assert.equal(res.data.product.priceCents, 2500);
  assert.equal(res.data.product.inventoryCount, 10);
  assert.equal(res.data.product.revision, 1);
  assert.equal(res.data.product.isPublished, true);

  const list = (await body(await products.GET(call("GET", "/api/products", { cookie })))).data;
  assert.equal(list.length, before + 1);
  assert.equal((await getProduct(cookie, res.data.product.id)).data.name, "Beaded bracelet");
});

test("price change and 'sold three' update the same product; revision increments", async () => {
  const { cookie } = await signIn();
  const { data } = await createAndApprove(cookie, { type: "create_product", product: bracelet });
  const id = data.product.id;

  const price = await createAndApprove(cookie, { type: "update_price", productId: id, priceCents: 3000, expectedRevision: 1 });
  assert.equal(price.data.product.priceCents, 3000);
  assert.equal(price.data.product.revision, 2);
  assert.deepEqual((await body(await draftById.GET(call("GET", `/api/drafts/${price.draftId}`, { cookie }), params({ id: price.draftId })))).data.previousValues, { priceCents: 2500 });

  const sold = await createAndApprove(cookie, { type: "adjust_stock", productId: id, delta: -3, expectedRevision: 2 });
  assert.equal(sold.data.product.id, id);
  assert.equal(sold.data.product.inventoryCount, 7);
  assert.equal(sold.data.product.priceCents, 3000);
  assert.equal(sold.data.product.revision, 3);
});

test("set stock to zero is sold out; negative stock is rejected", async () => {
  const { cookie } = await signIn();
  const { data } = await createAndApprove(cookie, { type: "create_product", product: { ...bracelet, inventoryCount: 1 } });
  const out = await createAndApprove(cookie, { type: "update_stock", productId: data.product.id, inventoryCount: 0, expectedRevision: 1 });
  assert.equal(out.data.product.soldOut, true);

  const neg = await drafts.POST(call("POST", "/api/drafts", { cookie, body: { type: "adjust_stock", productId: data.product.id, delta: -1, expectedRevision: 2 } }));
  assert.equal(neg.status, 409);
  const negSet = await drafts.POST(call("POST", "/api/drafts", { cookie, body: { type: "update_stock", productId: data.product.id, inventoryCount: -1, expectedRevision: 2 } }));
  assert.equal(negSet.status, 400);
});

test("update_product patch and update_storefront", async () => {
  const { cookie } = await signIn();
  const { data } = await createAndApprove(cookie, { type: "create_product", product: bracelet });
  const upd = await createAndApprove(cookie, { type: "update_product", productId: data.product.id, patch: { isFeatured: true, name: "Glass bead bracelet" }, expectedRevision: 1 });
  assert.equal(upd.data.product.isFeatured, true);
  assert.equal(upd.data.product.name, "Glass bead bracelet");

  const sf = await createAndApprove(cookie, { type: "update_storefront", patch: { heroTitle: "Made by hand", primaryColor: "#2F4F3A" } });
  assert.equal(sf.data.business.heroTitle, "Made by hand");
  assert.equal(sf.data.product, null);
});

test("reject leaves product untouched; resolved drafts cannot be re-resolved", async () => {
  const { cookie } = await signIn();
  const { data } = await createAndApprove(cookie, { type: "create_product", product: bracelet });
  const id = data.product.id;
  const d = await body(await drafts.POST(call("POST", "/api/drafts", { cookie, body: { type: "update_price", productId: id, priceCents: 1, expectedRevision: 1 } })));
  const r = await body(await reject.POST(call("POST", `/api/drafts/${d.data.id}/reject`, { cookie }), params({ id: d.data.id })));
  assert.equal(r.data.status, "rejected");
  const p = (await getProduct(cookie, id)).data;
  assert.equal(p.priceCents, 2500);
  assert.equal(p.revision, 1);

  assert.equal((await approve.POST(call("POST", "/x", { cookie }), params({ id: d.data.id }))).status, 409);
  assert.equal((await reject.POST(call("POST", "/x", { cookie }), params({ id: d.data.id }))).status, 409);
});

test("double approval and concurrent approval apply exactly once", async () => {
  const { cookie } = await signIn();
  const { data } = await createAndApprove(cookie, { type: "create_product", product: bracelet });
  const id = data.product.id;
  const d = await body(await drafts.POST(call("POST", "/api/drafts", { cookie, body: { type: "adjust_stock", productId: id, delta: -1, expectedRevision: 1 } })));

  const results = await Promise.all([1, 2, 3].map(() => approve.POST(call("POST", "/x", { cookie }), params({ id: d.data.id }))));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409, 409]);
  const p = (await getProduct(cookie, id)).data;
  assert.equal(p.inventoryCount, 9);
  assert.equal(p.revision, 2);

  // Double create_product approval does not create a second product.
  const c = await body(await drafts.POST(call("POST", "/api/drafts", { cookie, body: { type: "create_product", product: { ...bracelet, name: "Unique ring" } } })));
  await approve.POST(call("POST", "/x", { cookie }), params({ id: c.data.id }));
  assert.equal((await approve.POST(call("POST", "/x", { cookie }), params({ id: c.data.id }))).status, 409);
  const rings = (await body(await products.GET(call("GET", "/api/products", { cookie })))).data.filter((x: any) => x.name === "Unique ring");
  assert.equal(rings.length, 1);
});

test("stale revision → 409 at creation and at approval", async () => {
  const { cookie } = await signIn();
  const { data } = await createAndApprove(cookie, { type: "create_product", product: bracelet });
  const id = data.product.id;
  const a = await body(await drafts.POST(call("POST", "/api/drafts", { cookie, body: { type: "update_price", productId: id, priceCents: 3000, expectedRevision: 1 } })));
  const b = await body(await drafts.POST(call("POST", "/api/drafts", { cookie, body: { type: "update_stock", productId: id, inventoryCount: 4, expectedRevision: 1 } })));
  assert.equal((await approve.POST(call("POST", "/x", { cookie }), params({ id: a.data.id }))).status, 200);

  const stale = await approve.POST(call("POST", "/x", { cookie }), params({ id: b.data.id }));
  assert.equal(stale.status, 409);
  assert.equal((await body(stale)).error!.code, "STALE_REVISION");
  const after = (await getProduct(cookie, id)).data;
  assert.equal(after.inventoryCount, 10);
  assert.equal((await body(await draftById.GET(call("GET", "/x", { cookie }), params({ id: b.data.id })))).data.status, "pending");

  const late = await drafts.POST(call("POST", "/api/drafts", { cookie, body: { type: "update_price", productId: id, priceCents: 1, expectedRevision: 1 } }));
  assert.equal((await body(late)).error!.code, "STALE_REVISION");
});

test("invalid operations are rejected with INVALID_INPUT", async () => {
  const { cookie } = await signIn();
  const cases = [
    { type: "delete_everything" },
    { type: "create_product", product: { ...bracelet, priceCents: 24.5 } },
    { type: "create_product", product: { ...bracelet, priceCents: -1 } },
    { type: "create_product", product: { ...bracelet, name: "" } },
    { type: "create_product", product: bracelet, confirmed: true },
    { type: "update_price", productId: "bracelet", priceCents: 100, expectedRevision: 1 },
    { type: "update_price", productId: crypto.randomUUID(), priceCents: 100 },
    { type: "update_product", productId: crypto.randomUUID(), patch: {}, expectedRevision: 1 },
    { type: "update_storefront", patch: { primaryColor: "green" } },
  ];
  for (const c of cases) {
    const res = await drafts.POST(call("POST", "/api/drafts", { cookie, body: c }));
    assert.equal(res.status, 400, JSON.stringify(c));
    assert.equal((await body(res)).error!.code, "INVALID_INPUT");
  }
  const missing = await drafts.POST(call("POST", "/api/drafts", { cookie, body: { type: "update_price", productId: crypto.randomUUID(), priceCents: 1, expectedRevision: 1 } }));
  assert.equal(missing.status, 404);
  const badImage = await drafts.POST(call("POST", "/api/drafts", { cookie, body: { type: "create_product", product: { ...bracelet, imageAssetId: crypto.randomUUID() } } }));
  assert.equal(badImage.status, 404);
});

test("cross-business: other merchant cannot read or mutate products or drafts", async () => {
  const { cookie: mine } = await signIn();
  const { data } = await createAndApprove(mine, { type: "create_product", product: bracelet });
  const myDraft = await body(await drafts.POST(call("POST", "/api/drafts", { cookie: mine, body: { type: "update_price", productId: data.product.id, priceCents: 1, expectedRevision: 1 } })));

  const { cookie: theirs } = await signIn("rival@shop.example", "Rival Shop");
  assert.equal((await getProduct(theirs, data.product.id)).error!.code, "NOT_FOUND");
  assert.equal((await body(await products.GET(call("GET", "/api/products", { cookie: theirs })))).data.length, 0);
  assert.equal((await draftById.GET(call("GET", "/x", { cookie: theirs }), params({ id: myDraft.data.id }))).status, 404);
  assert.equal((await approve.POST(call("POST", "/x", { cookie: theirs }), params({ id: myDraft.data.id }))).status, 404);
  assert.equal((await reject.POST(call("POST", "/x", { cookie: theirs }), params({ id: myDraft.data.id }))).status, 404);
  const steal = await drafts.POST(call("POST", "/api/drafts", { cookie: theirs, body: { type: "update_price", productId: data.product.id, priceCents: 1, expectedRevision: 1 } }));
  assert.equal(steal.status, 404);
  assert.equal((await getProduct(mine, data.product.id)).data.priceCents, 2500);
});
