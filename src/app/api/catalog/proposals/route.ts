import { proposeCatalogBatchInput } from "@/integrations/catalog-batches/types";
import { readWorkspaceJson, requireWorkspaceOwner } from "@/integrations/call-workspace/http";
import { callWorkspace } from "@/integrations/call-workspace/runtime";
import { handle, ok } from "@/server/http";
import { repository } from "@/server/repository";

export const POST = handle(async (req: Request) => {
  const owner = requireWorkspaceOwner(req);
  const input = proposeCatalogBatchInput.parse(await readWorkspaceJson(req));
  callWorkspace().store.assertActive(owner, input.callId);
  return ok(await repository().proposeCatalogBatch(owner.businessId, input), { status: 201 });
});
