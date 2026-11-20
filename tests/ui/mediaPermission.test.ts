import test from "node:test";
import assert from "node:assert/strict";
import { checkMicrophone } from "../../src/features/call/mediaPermission";

test("microphone preflight requests audio only and releases its temporary tracks", async () => {
  let requested: MediaStreamConstraints | undefined;
  let stopped = 0;
  const error = await checkMicrophone({ async getUserMedia(constraints) {
    requested = constraints;
    return { getTracks: () => [{ stop() { stopped++; } }] } as unknown as MediaStream;
  } });
  assert.equal(error, null);
  assert.deepEqual(requested, { audio: true, video: false });
  assert.equal(stopped, 1);
});

test("permission/device errors give specific retry guidance without exposing raw provider text", async () => {
  for (const [name, expected] of [["NotAllowedError", /blocked/], ["NotFoundError", /No microphone/], ["NotReadableError", /other apps/]] as const) {
    const message = await checkMicrophone({ async getUserMedia() { throw new DOMException("sensitive raw error must not appear", name); } });
    assert.match(message!, expected);
    assert.equal(message!.includes("sensitive raw error"), false);
  }
  assert.match((await checkMicrophone(undefined))!, /secure browser/);
});
