import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { body, bracelet, call, createAndApprove, params, signIn } from "./helpers/backend";
import * as uploads from "../src/app/api/uploads/route";
import * as assets from "../src/app/api/assets/[id]/route";

const png = () => sharp({ create: { width: 8, height: 6, channels: 3, background: "#3366aa" } }).png().toBuffer();
function upload(cookie: string | undefined, bytes: Uint8Array, type: string, name = "photo") {
  const form = new FormData();
  form.set("file", new Blob([bytes as BlobPart], { type }), name);
  return uploads.POST(call("POST", "/api/uploads", { cookie, raw: form }));
}

test("valid PNG is stored durably, persisted, and attachable to a product", async () => {
  const { cookie } = await signIn();
  const res = await upload(cookie, await png(), "image/png");
  assert.equal(res.status, 201);
  const a = (await body(res)).data;
  assert.equal(a.mimeType, "image/png");
  assert.equal(a.width, 8);
  assert.equal(a.url, `https://api.shopcall.test/api/assets/${a.id}`);
  assert.equal("storageKey" in a, false);

  // Owner can read the original back; anonymous cannot until it is on a published product.
  const own = await assets.GET(call("GET", "/x", { cookie }), params({ id: a.id }));
  assert.equal(own.status, 200);
  assert.deepEqual(new Uint8Array(await own.arrayBuffer()), new Uint8Array(await png()));
  assert.equal((await assets.GET(call("GET", "/x"), params({ id: a.id }))).status, 404);

  const created = await createAndApprove(cookie, { type: "create_product", product: { ...bracelet, imageAssetId: a.id } });
  assert.equal(created.data.product.imageUrl, a.url);
  const anon = await assets.GET(call("GET", "/x"), params({ id: a.id }));
  assert.equal(anon.status, 200);
  assert.equal(anon.headers.get("content-type"), "image/png");
});

test("JPEG and WebP accepted", async () => {
  const { cookie } = await signIn();
  const img = sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } });
  assert.equal((await upload(cookie, await img.clone().jpeg().toBuffer(), "image/jpeg")).status, 201);
  assert.equal((await upload(cookie, await img.clone().webp().toBuffer(), "image/webp")).status, 201);
});

test("unsupported, spoofed, and corrupt files are rejected", async () => {
  const { cookie } = await signIn();
  const gif = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "binary");
  assert.equal((await upload(cookie, gif, "image/gif")).status, 415);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal((await upload(cookie, svg, "image/png")).status, 415);
  assert.equal((await upload(cookie, await png(), "image/jpeg")).status, 415); // declared type mismatch
  const truncated = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
  assert.equal((await upload(cookie, truncated, "image/png")).status, 415);
  const noFile = await uploads.POST(call("POST", "/api/uploads", { cookie, raw: new FormData() }));
  assert.equal(noFile.status, 400);
});

test("oversized image → 413", async () => {
  const { cookie } = await signIn();
  process.env.UPLOAD_MAX_BYTES = "50";
  try {
    const res = await upload(cookie, await png(), "image/png");
    assert.equal(res.status, 413);
    assert.equal((await body(res)).error!.code, "PAYLOAD_TOO_LARGE");
  } finally {
    delete process.env.UPLOAD_MAX_BYTES;
  }
});

test("unauthenticated upload → 401", async () => {
  assert.equal((await upload(undefined, await png(), "image/png")).status, 401);
});

test("storage failure → 502 and nothing persisted; no storage configured → 503", async () => {
  const { cookie } = await signIn("storage@shop.example", "Storage Shop");
  const dir = process.env.ASSET_STORAGE_DIR!;
  const blocker = path.join(dir, "not-a-dir");
  writeFileSync(blocker, "x");
  process.env.ASSET_STORAGE_DIR = blocker; // mkdir under a regular file fails
  try {
    const res = await upload(cookie, await png(), "image/png");
    assert.equal(res.status, 502);
    assert.equal((await body(res)).error!.code, "STORAGE_ERROR");

    delete process.env.ASSET_STORAGE_DIR;
    const unconfigured = await upload(cookie, await png(), "image/png");
    assert.equal(unconfigured.status, 503);
    assert.equal((await body(unconfigured)).error!.code, "CONFIGURATION_ERROR");
  } finally {
    process.env.ASSET_STORAGE_DIR = dir;
  }
  // Neither failure persisted asset metadata.
  const { getDb } = await import("../src/server/db");
  const n = getDb().prepare("SELECT COUNT(*) AS n FROM assets a JOIN businesses b ON b.id = a.business_id WHERE b.slug = 'storage-shop'").get() as { n: number };
  assert.equal(n.n, 0);
});
