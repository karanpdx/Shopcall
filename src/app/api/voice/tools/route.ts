import { z } from "zod";
import { handle, ok } from "@/server/http";
import { CLIENT_TOOL_NAMES } from "@/contracts/integrations";
import { callWorkspace } from "@/integrations/call-workspace/runtime";
import { readWorkspaceJson, requireWorkspaceOwner } from "@/integrations/call-workspace/http";

export const POST = handle(async (req: Request) => {
  const owner = requireWorkspaceOwner(req);
  const input = z.object({ callId: z.uuid(), name: z.enum(CLIENT_TOOL_NAMES), arguments: z.unknown(), idempotencyKey: z.string().min(1).max(160) }).strict().parse(await readWorkspaceJson(req));
  return ok(await callWorkspace().tool(owner, input.callId, input.name, input.arguments, input.idempotencyKey));
});
