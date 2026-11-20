import { requireWorkspaceOwner } from "@/integrations/call-workspace/http";
import { callWorkspace } from "@/integrations/call-workspace/runtime";
import { handle, ok, type IdParams } from "@/server/http";
import { repository } from "@/server/repository";

export const GET = handle(async (req: Request, { params }: IdParams) => {
  const owner = requireWorkspaceOwner(req);
  const batch = repository().getCatalogBatch(owner.businessId, (await params).id);
  callWorkspace().store.getCall(owner, batch.callId);
  return ok(batch);
});
