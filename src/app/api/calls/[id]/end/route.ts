import { handle, ok, type IdParams } from "@/server/http";
import { callWorkspace } from "@/integrations/call-workspace/runtime";
import { requireWorkspaceOwner } from "@/integrations/call-workspace/http";

export const POST = handle(async (req: Request, { params }: IdParams) => {
  const owner = requireWorkspaceOwner(req);
  return ok(callWorkspace().store.endCall(owner, (await params).id));
});
