import { handle, ok, type IdParams } from "@/server/http";
import { callWorkspace } from "@/integrations/call-workspace/runtime";
import { readWorkspaceJson, requireWorkspaceOwner } from "@/integrations/call-workspace/http";

export const POST = handle(async (req: Request, { params }: IdParams) => {
  const owner = requireWorkspaceOwner(req);
  const input = await readWorkspaceJson(req);
  return ok(await callWorkspace().prepareCallReview(owner, (await params).id, input));
});
