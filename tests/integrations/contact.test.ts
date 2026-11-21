import test from "node:test";
import assert from "node:assert/strict";
import { approvedContactLink } from "../../src/integrations/publication/contact";

test("contact verification accepts encoded approved recipient with inquiry subject/body", () => {
  assert.equal(approvedContactLink("mailto:owner@example.com", "owner@example.com"), true);
  assert.equal(approvedContactLink("mailto:owner%40example.com?subject=Product%20inquiry&body=Hello", "owner@example.com"), true);
});

test("contact verification rejects another recipient, extra recipient headers and malformed encoding", () => {
  for (const link of ["mailto:other@example.com", "mailto:owner@example.com,other@example.com", "mailto:owner@example.com?bcc=other@example.com", "mailto:owner@example.com?CC=other@example.com", "mailto:owner@example.com?to=other@example.com", "https://example.com", "mailto:owner%0d%0aBcc%3Aother@example.com", "mailto:owner%ZZ@example.com"]) {
    assert.equal(approvedContactLink(link, "owner@example.com"), false, link);
  }
});
