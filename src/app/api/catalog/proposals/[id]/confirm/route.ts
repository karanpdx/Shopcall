import { approveCatalogBatchInput } from "@/integrations/catalog-batches/types";
import { readWorkspaceJson, requireWorkspaceOwner } from "@/integrations/call-workspace/http";
import { callWorkspace } from "@/integrations/call-workspace/runtime";
import { handle, ok, type IdParams } from "@/server/http";
import { repository } from "@/server/repository";

export const POST = handle(async (req: Request, { params }: IdParams) => {
  const owner = requireWorkspaceOwner(req);
  const id = (await params).id;
  const batch = repository().getCatalogBatch(owner.businessId, id);
  callWorkspace().store.getCall(owner, batch.callId);
  return ok(await repository().approveCatalogBatch(owner.businessId, id, approveCatalogBatchInput.parse(await readWorkspaceJson(req))));
});
