import { z } from "zod";
import { fail, handle, ok } from "@/server/http";
import { storeOriginalImage } from "@/server/uploads";
import { repository } from "@/server/repository";
import { assetUrl } from "@/server/config";
import { callWorkspace } from "@/integrations/call-workspace/runtime";
import { readWorkspaceJson, requireWorkspaceOwner } from "@/integrations/call-workspace/http";

type Params = { params: Promise<{ id: string; draftId: string }> };
export const POST = handle(async (req: Request, { params }: Params) => {
  const owner = requireWorkspaceOwner(req); const { id, draftId } = await params;
  const workspace = callWorkspace();
  workspace.store.getDraft(owner, id, draftId); // Check ownership before storage/upload work.
  await workspace.editable(owner, id, draftId);
  if (req.headers.get("content-type")?.includes("application/json")) {
    const input = z.object({ imageAssetId: z.uuid(), capturedAt: z.iso.datetime({ offset: true }) }).strict().parse(await readWorkspaceJson(req));
    const existing = repository().getAssetForServing(input.imageAssetId);
    if (!existing || existing.businessId !== owner.businessId) return fail(404, "NOT_FOUND", "Image asset not found for this business.");
    return ok(await workspace.attachImage(owner, id, draftId, { id: input.imageAssetId, businessId: owner.businessId, url: assetUrl(input.imageAssetId) }, input.capturedAt));
  }
  const capturedAt = req.headers.get("x-captured-at") ?? new Date().toISOString();
  z.iso.datetime({ offset: true }).parse(capturedAt);
  const asset = await storeOriginalImage(req, owner.businessId);
  return ok(await workspace.attachImage(owner, id, draftId, asset, capturedAt), { status: 201 });
});
