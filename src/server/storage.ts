import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fail } from "./http";

export interface BlobStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

/**
 * S3-compatible object storage (AWS S3, Cloudflare R2, MinIO…) when S3_BUCKET is set; a directory when
 * ASSET_STORAGE_DIR is set (local dev or a mounted persistent volume only). Otherwise uploads fail with 503.
 */
export function blobStore(): BlobStore {
  const env = process.env;
  if (env.S3_BUCKET) {
    const { S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
    if (!S3_ENDPOINT || !S3_REGION || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
      return fail(503, "CONFIGURATION_ERROR", "S3_BUCKET is set but S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID or S3_SECRET_ACCESS_KEY is missing.");
    }
    return s3Store({ endpoint: S3_ENDPOINT, region: S3_REGION, bucket: env.S3_BUCKET, accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY });
  }
  if (env.ASSET_STORAGE_DIR) return fsStore(path.resolve(env.ASSET_STORAGE_DIR));
  return fail(503, "CONFIGURATION_ERROR", "No durable image storage configured (set S3_* variables or ASSET_STORAGE_DIR).");
}

function fsStore(root: string): BlobStore {
  const resolve = (key: string) => {
    const p = path.join(root, key);
    if (!p.startsWith(root + path.sep)) throw new Error("Invalid storage key");
    return p;
  };
  return {
    async put(key, body) {
      const p = resolve(key);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, body, { flag: "wx" });
    },
    async get(key) {
      try {
        return await readFile(resolve(key));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
  };
}

type S3Config = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };

function s3Store(c: S3Config): BlobStore {
  // Path-style addressing: works for R2, MinIO and AWS S3.
  const objectUrl = (key: string) => `${c.endpoint.replace(/\/$/, "")}/${c.bucket}/${key.split("/").map(encodeRfc3986).join("/")}`;
  return {
    async put(key, body, contentType) {
      const url = objectUrl(key);
      const headers = signV4({ method: "PUT", url, headers: { "content-type": contentType }, payloadHash: sha256Hex(body), ...c, date: new Date() });
      const res = await fetch(url, { method: "PUT", headers, body: body as BodyInit });
      if (!res.ok) throw new Error(`S3 PUT failed with HTTP ${res.status}`);
    },
    async get(key) {
      const url = objectUrl(key);
      const headers = signV4({ method: "GET", url, headers: {}, payloadHash: sha256Hex(""), ...c, date: new Date() });
      const res = await fetch(url, { headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`S3 GET failed with HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
const encodeRfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

/** AWS Signature Version 4 request headers (excluding `host`, which fetch sets itself). */
export function signV4(o: {
  method: string; url: string; headers: Record<string, string>; payloadHash: string;
  region: string; accessKeyId: string; secretAccessKey: string; date: Date; service?: string;
}): Record<string, string> {
  const u = new URL(o.url);
  const amzDate = o.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const service = o.service ?? "s3";
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.headers)) h[k.toLowerCase()] = v.trim();
  h.host = u.host;
  h["x-amz-date"] = amzDate;
  h["x-amz-content-sha256"] = o.payloadHash;
  const names = Object.keys(h).sort();
  const canonicalQuery = [...u.searchParams].map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).sort().join("&");
  const canonicalRequest = [
    o.method, u.pathname, canonicalQuery, names.map(n => `${n}:${h[n]}\n`).join(""), names.join(";"), o.payloadHash,
  ].join("\n");
  const scope = `${day}/${o.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, day), o.region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  const { host: _host, ...rest } = h;
  return { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}
