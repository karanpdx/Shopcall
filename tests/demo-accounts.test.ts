import test from "node:test";
import assert from "node:assert/strict";
import { body, bracelet, call, createAndApprove, params, signIn } from "./helpers/backend";
import { POST as login } from "../src/app/api/auth/login/route";
import { GET as products } from "../src/app/api/products/route";
import { GET as product } from "../src/app/api/products/[id]/route";
import { SqliteBackendJobSource } from "../src/integrations/backend/source";
import { getDb } from "../src/server/db";
import { repository } from "../src/server/repository";

test("second fixed demo account starts empty and cannot read the first account's products", async () => {
  process.env.DEMO_SECOND_OWNER_EMAIL = "fresh@example.com";
  process.env.DEMO_SECOND_OWNER_PASSWORD = "separate demo password";
  process.env.DEMO_SECOND_BUSINESS_NAME = "Fresh store";
  const primary = await signIn();
  const saved = await createAndApprove(primary.cookie, { type: "create_product", product: bracelet });
  const response = await login(call("POST", "/api/auth/login", { body: { email: "fresh@example.com", password: "separate demo password" } }));
  assert.equal(response.status, 200);
  const second = (await body(response)).data;
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  assert.notEqual(second.owner.id, primary.session.owner.id);
  assert.notEqual(second.business.id, primary.session.business.id);
  assert.deepEqual((await body(await products(call("GET", "/api/products", { cookie })))).data, []);
  assert.equal((await product(call("GET", `/api/products/${saved.data.product.id}`, { cookie }), params({ id: saved.data.product.id }))).status, 404);
  assert.equal((await body(await products(call("GET", "/api/products", { cookie: primary.cookie })))).data.length, 1);
  const source = new SqliteBackendJobSource(getDb(), repository());
  assert.equal(await source.getVerifiedOwnerEmail(second.owner.id, second.business.id), "fresh@example.com");
  assert.equal(await source.getVerifiedOwnerEmail(second.owner.id, primary.session.business.id), null);
});

test("demo logins require a matched email/password pair", async () => {
  const response = await login(call("POST", "/api/auth/login", { body: { email: "fresh@example.com", password: "correct horse battery" } }));
  assert.equal(response.status, 401);
  assert.equal(response.headers.has("set-cookie"), false);
});
