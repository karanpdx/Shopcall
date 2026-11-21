import { z } from "zod";
import { handle, ok } from "@/server/http";
import { callWorkspace } from "@/integrations/call-workspace/runtime";
import { readWorkspaceJson, requireWorkspaceOwner } from "@/integrations/call-workspace/http";

export const POST = handle(async (req: Request) => {
  const owner = requireWorkspaceOwner(req);
  const input = z.object({ mode: z.enum(["create", "update"]), idempotencyKey: z.string().min(1).max(160) }).strict().parse(await readWorkspaceJson(req));
  const workspace = callWorkspace();
  const call = workspace.store.createCall(owner, input);
  return ok(await workspace.current(owner, call.id), { status: 201 });
});
