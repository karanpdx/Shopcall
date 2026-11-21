import { handle, ok } from "@/server/http";
import { callWorkspace } from "@/integrations/call-workspace/runtime";
import { draftPatch } from "@/integrations/call-workspace/store";
import { readWorkspaceJson, requireWorkspaceOwner } from "@/integrations/call-workspace/http";

type Params = { params: Promise<{ id: string; draftId: string }> };
export const PATCH = handle(async (req: Request, { params }: Params) => {
  const owner = requireWorkspaceOwner(req); const { id, draftId } = await params;
  return ok(await callWorkspace().updateDraft(owner, id, draftId, draftPatch.parse(await readWorkspaceJson(req))));
});
