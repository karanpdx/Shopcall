import { handle, ok } from "@/server/http";
import { callWorkspace } from "@/integrations/call-workspace/runtime";
import { requireWorkspaceOwner } from "@/integrations/call-workspace/http";

type Params = { params: Promise<{ id: string; draftId: string }> };
export const POST = handle(async (req: Request, { params }: Params) => {
  const owner = requireWorkspaceOwner(req); const { id, draftId } = await params;
  return ok({ proposal: await callWorkspace().proposeProduct(owner, id, draftId), applied: false, requiresOwnerReview: true });
});
