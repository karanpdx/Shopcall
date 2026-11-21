import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createProductMediaProvider } from "../../src/integrations/product-media/provider";

const fixture = () => sharp({ create: { width: 64, height: 64, channels: 3, background: "#a7542a" } }).png().toBuffer();
test("vision sends only bounded image/notes and strictly rejects extra inferred price fields", async () => {
  let calls = 0;
  const provider = createProductMediaProvider({ apiKey: "test-secret", fetch: async (url, init) => {
    calls++; assert.equal(String(url), "https://ai-gateway.vercel.sh/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format.json_schema.strict, true);
    assert.match(body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ title: "Orange item", description: "Warm orange rectangular item.", price: 20 }) } }] });
  } });
  await assert.rejects(provider.analyze({ bytes: await fixture(), mimeType: "image/png" }), { code: "MEDIA_ANALYSIS_INVALID" });
  assert.equal(calls, 1, "Malformed output never triggers a paid retry.");
});

test("enhancement accepts inline image only, never follows a provider-returned remote URL", async () => {
  let calls = 0;
  const provider = createProductMediaProvider({ apiKey: "test-secret", fetch: async () => {
    calls++; return Response.json({ choices: [{ message: { images: [{ image_url: { url: "http://127.0.0.1/private" } }] } }] });
  } });
  await assert.rejects(provider.enhance({ bytes: await fixture(), mimeType: "image/png" }), { code: "MEDIA_IMAGE_MISSING" });
  assert.equal(calls, 1);
});

test("provider errors remain sanitized and uncertain failures are not retried", async () => {
  const provider = createProductMediaProvider({ apiKey: "test-secret", fetch: async () => Response.json({ error: "test-secret and merchant notes" }, { status: 402 }) });
  await assert.rejects(provider.analyze({ bytes: await fixture(), mimeType: "image/png" }), { code: "MEDIA_PROVIDER_HTTP_402", message: "MEDIA_PROVIDER_HTTP_402" });
});

test("valid generated photo becomes a decodable separate WebP, with actual model evidence", async () => {
  const original = await fixture();
  const provider = createProductMediaProvider({ apiKey: "test-secret", fetch: async () => Response.json({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${original.toString("base64")}` } }] } }] }) });
  const result = await provider.enhance({ bytes: original, mimeType: "image/png" });
  assert.equal(result.mimeType, "image/webp");
  assert.equal((await sharp(result.bytes).metadata()).format, "webp");
  assert.notDeepEqual(result.bytes, original);
  assert.equal(result.model, "google/gemini-2.5-flash-image");
});
