import { handle, ok } from "@/server/http";
import { requireWorkspaceOwner } from "@/integrations/call-workspace/http";
import { productMediaService } from "@/integrations/product-media/runtime";

type Params = { params: Promise<{ id: string; draftId: string }> };
export const GET = handle(async (req: Request, { params }: Params) => {
  const owner = requireWorkspaceOwner(req); const { id, draftId } = await params;
  return ok(productMediaService().getForDraft(owner, id, draftId));
});
