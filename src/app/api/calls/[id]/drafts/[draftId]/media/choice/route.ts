import { handle, ok } from "@/server/http";
import { requireWorkspaceOwner, readWorkspaceJson } from "@/integrations/call-workspace/http";
import { productMediaService } from "@/integrations/product-media/runtime";

type Params = { params: Promise<{ id: string; draftId: string }> };
export const POST = handle(async (req: Request, { params }: Params) => {
  const owner = requireWorkspaceOwner(req); const { id, draftId } = await params;
  return ok(productMediaService().applyChoice(owner, id, draftId, await readWorkspaceJson(req)));
});
