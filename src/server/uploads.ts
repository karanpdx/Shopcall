import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Asset } from "@/contracts/api";
import { uploadMaxBytes } from "./config";
import { fail } from "./http";
import { repository } from "./repository";
import { blobStore } from "./storage";

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
type Mime = keyof typeof EXT;

/** Content sniffing: the declared type is never trusted on its own. */
function sniff(b: Uint8Array): Mime | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "image/png";
  const ascii = (s: number, e: number) => String.fromCharCode(...b.subarray(s, e));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Validates and durably stores an original product image; persists metadata only after storage succeeded. */
export async function storeOriginalImage(req: Request, businessId: string): Promise<Asset> {
  const max = uploadMaxBytes();
  const declared = Number(req.headers.get("content-length"));
  if (declared > max + 64 * 1024) fail(413, "PAYLOAD_TOO_LARGE", `Image exceeds ${max} bytes.`);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "INVALID_INPUT", "Expected multipart/form-data with a 'file' field.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) return fail(400, "INVALID_INPUT", "Missing 'file' field.");
  if (file.size === 0) fail(400, "INVALID_INPUT", "File is empty.");
  if (file.size > max) fail(413, "PAYLOAD_TOO_LARGE", `Image exceeds ${max} bytes.`);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniff(bytes);
  if (!mime) return fail(415, "UNSUPPORTED_MEDIA_TYPE", "Only JPEG, PNG and WebP images are accepted.");
  if (file.type && file.type !== mime) fail(415, "UNSUPPORTED_MEDIA_TYPE", `Declared type ${file.type} does not match file contents (${mime}).`);

  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    meta = await sharp(bytes).metadata();
  } catch {
    return fail(415, "UNSUPPORTED_MEDIA_TYPE", "File is not a decodable image.");
  }
  if (!meta.width || !meta.height) return fail(415, "UNSUPPORTED_MEDIA_TYPE", "Image has no dimensions.");

  const store = blobStore(); // 503 if no durable storage configured
  const id = randomUUID();
  const storageKey = `businesses/${businessId}/originals/${id}.${EXT[mime]}`;
  try {
    await store.put(storageKey, bytes, mime);
  } catch (e) {
    console.error("[uploads] storage put failed", e);
    return fail(502, "STORAGE_ERROR", "Image could not be saved to storage. Nothing was persisted.");
  }
  return repository().createAsset({ id, businessId, storageKey, mimeType: mime, sizeBytes: bytes.length, width: meta.width, height: meta.height });
}
