import test from "node:test";
import assert from "node:assert/strict";
import { phaseSteps, verifiedUrl } from "../../src/features/call/status";

test("public URL is only shown for ready jobs with an https URL", () => {
  assert.equal(verifiedUrl({ phase: "publishing", publicUrl: "https://shop.example" }), null);
  assert.equal(verifiedUrl({ phase: "verifying", publicUrl: "https://shop.example" }), null);
  assert.equal(verifiedUrl({ phase: "failed", publicUrl: "https://shop.example" }), null);
  assert.equal(verifiedUrl({ phase: "ready", publicUrl: null }), null);
  assert.equal(verifiedUrl({ phase: "ready", publicUrl: "javascript:alert(1)" }), null);
  assert.equal(verifiedUrl({ phase: "ready", publicUrl: "https://shop.example/" }), "https://shop.example/");
});

test("phase steps mark progress honestly", () => {
  const steps = phaseSteps("building");
  assert.equal(steps.find(s => s.phase === "creating")?.state, "done");
  assert.equal(steps.find(s => s.phase === "building")?.state, "current");
  assert.equal(steps.find(s => s.phase === "ready")?.state, "todo");
  assert.equal(phaseSteps("failed").at(-1)?.state, "failed");
});
