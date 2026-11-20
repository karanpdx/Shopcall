import { z } from "zod";
import { handle, ok, type IdParams } from "@/server/http";
import { callWorkspace } from "@/integrations/call-workspace/runtime";
import { readWorkspaceJson, requireWorkspaceOwner } from "@/integrations/call-workspace/http";

export const POST = handle(async (req: Request, { params }: IdParams) => {
  const owner = requireWorkspaceOwner(req);
  const input = z.object({ proposedTitle: z.string().min(1).max(160).optional(), idempotencyKey: z.string().min(1).max(160) }).strict().parse(await readWorkspaceJson(req));
  return ok(callWorkspace().store.createDraft(owner, (await params).id, input.idempotencyKey, input.proposedTitle), { status: 201 });
});
