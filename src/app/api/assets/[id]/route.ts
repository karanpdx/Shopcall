import { currentOwner } from "@/server/auth";
import { fail, handle, type IdParams } from "@/server/http";
import { repository } from "@/server/repository";
import { blobStore } from "@/server/storage";

/** Public if attached to a published product; otherwise only the owning merchant. 404 hides existence. */
export const GET = handle(async (req: Request, { params }: IdParams) => {
  const asset = repository().getAssetForServing((await params).id);
  if (!asset || (!asset.isPublic && currentOwner(req)?.businessId !== asset.businessId)) return fail(404, "NOT_FOUND", "Asset not found");
  let bytes: Uint8Array | null;
  try {
    bytes = await blobStore().get(asset.storageKey);
  } catch (e) {
    console.error("[assets] storage get failed", e);
    return fail(502, "STORAGE_ERROR", "Image could not be read from storage.");
  }
  if (!bytes) return fail(404, "NOT_FOUND", "Asset not found");
  return new Response(bytes as BodyInit, {
    headers: {
      "content-type": asset.mimeType,
      "x-content-type-options": "nosniff",
      "cache-control": asset.isPublic ? "public, max-age=3600" : "private, no-store",
    },
  });
});
