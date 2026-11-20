import test from "node:test";
import assert from "node:assert/strict";
import { draftsReducer, initialDrafts, missingFields, parsePriceToMinor } from "../../src/features/call/drafts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function twoDrafts() {
  let s = draftsReducer(initialDrafts, { type: "draft_saved", draft: { id: A, title: "Blue mug" } });
  s = draftsReducer(s, { type: "draft_saved", draft: { id: B, title: "White bowl" } });
  return s;
}

test("async capture started on draft A never attaches to draft B", () => {
  let s = twoDrafts();
  s = draftsReducer(s, { type: "set_active", draftId: A });
  s = draftsReducer(s, { type: "capture_started", draftId: A, localId: "c1", previewUrl: "blob:1" });
  s = draftsReducer(s, { type: "set_active", draftId: B }); // owner moves on mid-upload
  s = draftsReducer(s, { type: "capture_settled", draftId: A, localId: "c1", result: { ok: true, data: { captureId: "cap", productDraftId: A, thumbnailUrl: "https://x/t.jpg" } } });
  assert.equal(s.activeId, B);
  assert.equal(s.byId[A].captures[0].status, "saved");
  assert.equal(s.byId[B].captures.length, 0);
});

test("server response bound to a different draft is rejected, not saved", () => {
  let s = twoDrafts();
  s = draftsReducer(s, { type: "capture_started", draftId: A, localId: "c1", previewUrl: "blob:1" });
  s = draftsReducer(s, { type: "capture_settled", draftId: A, localId: "c1", result: { ok: true, data: { captureId: "cap", productDraftId: B, thumbnailUrl: "t" } } });
  assert.equal(s.byId[A].captures[0].status, "failed");
  assert.equal(s.byId[B].captures.length, 0);
});

test("failed upload is shown as not saved", () => {
  let s = twoDrafts();
  s = draftsReducer(s, { type: "capture_started", draftId: A, localId: "c1", previewUrl: "blob:1" });
  s = draftsReducer(s, { type: "capture_settled", draftId: A, localId: "c1", result: { ok: false, message: "network" } });
  assert.equal(s.byId[A].captures[0].status, "failed");
  assert.deepEqual(missingFields(s.byId[A]).includes("photo"), true);
});

test("owner correction overwrites fields and new drafts become active", () => {
  let s = twoDrafts();
  assert.equal(s.activeId, B);
  s = draftsReducer(s, { type: "draft_saved", draft: { id: A, title: "Tall vase", priceMinor: 4500, inventoryTracked: true, quantityOnHand: 1 } });
  assert.equal(s.byId[A].title, "Tall vase");
  assert.deepEqual(missingFields(s.byId[A]), ["photo"]);
  assert.equal(s.order.length, 2);
});

test("price parsing uses integer minor units and rejects junk", () => {
  assert.equal(parsePriceToMinor("$24.00"), 2400);
  assert.equal(parsePriceToMinor("24.5"), 2450);
  assert.equal(parsePriceToMinor("1,200"), 120000);
  assert.equal(parsePriceToMinor("0"), 0);
  assert.equal(parsePriceToMinor("-1"), null);
  assert.equal(parsePriceToMinor("24.555"), null);
  assert.equal(parsePriceToMinor("abc"), null);
});
