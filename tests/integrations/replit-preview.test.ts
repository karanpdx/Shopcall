import test from "node:test";
import assert from "node:assert/strict";
import { ReplitLivePreviewLocator } from "../../src/integrations/replit/preview-locator";
import type { ReplitMcpClient } from "../../src/integrations/replit/client";

const replId = "ec75a51d-d0f4-4737-9d0d-2dbb1dd4182b";
function fixture(text: string, phase: "busy" | "paused" = "paused", returnedId = replId) {
  const client: Pick<ReplitMcpClient, "call"> = {
    call: async name => {
      assert.equal(name, "ask_question");
      return { content: [], structuredContent: { replId: returnedId, phase, response: text } };
    },
  };
  return { client };
}

test("busy or wrong-app answers cannot supply preview location", async () => {
  for (const f of [fixture("https://app.replit.dev/", "busy"), fixture("https://app.replit.dev/", "paused", "wrong-app")]) {
    assert.equal(await new ReplitLivePreviewLocator(f.client).locate(replId), null);
  }
});

test("checkpoint SHA in Agent answer never triggers unsupported internal widget tools", async () => {
  const f = fixture(JSON.stringify({ gitSha: "a".repeat(40), previewUrl: "https://agent-candidate.replit.dev/" }));
  assert.deepEqual(await new ReplitLivePreviewLocator(f.client).locateDetailed(replId), { state: "candidate", source: "agent-candidate", url: "https://agent-candidate.replit.dev/" });
});

test("URL-only candidate stays constrained to public credential-free Replit preview domain", async () => {
  for (const unsafe of ["http://app.replit.dev/", "https://127.0.0.1/", "https://replit.dev.attacker.com/", "https://app.replit.dev/?token=secret", "https://u:p@app.replit.dev/", "https://app.replit.dev:8443/", "https://app.replit.dev/#secret"]) {
    const f = fixture(JSON.stringify({ previewUrl: unsafe }));
    assert.equal(await new ReplitLivePreviewLocator(f.client).locate(replId), null, unsafe);
  }
  const f = fixture("Actual candidate URL: https://app.replit.dev/ . This does not attest build success.");
  assert.equal(await new ReplitLivePreviewLocator(f.client).locate(replId), "https://app.replit.dev/");
});

test("missing candidate is pending and malformed provider envelope is blocked", async () => {
  const f = fixture("Preview is not available yet.");
  assert.deepEqual(await new ReplitLivePreviewLocator(f.client).locateDetailed(replId), { state: "pending", code: "PREVIEW_LOCATION_UNAVAILABLE" });
  f.client.call = async () => ({ content: [{ type: "text", text: "https://app.replit.dev/" }] });
  assert.deepEqual(await new ReplitLivePreviewLocator(f.client).locateDetailed(replId), { state: "blocked", code: "PREVIEW_RESPONSE_UNVERIFIED" });
});
