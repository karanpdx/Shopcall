import test from "node:test";
import assert from "node:assert/strict";
import { signV4 } from "../src/server/storage";

// AWS documented example "GET Object" (Signature Version 4, header-based auth). Verifies the signer only,
// not connectivity to a real bucket.
test("SigV4 signer matches the AWS reference example", () => {
  const h = signV4({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    headers: { range: "bytes=0-9" },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    date: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(h.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
    "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
    "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.equal(h.host, undefined);
});
