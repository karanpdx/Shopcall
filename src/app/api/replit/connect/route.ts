import { handle, ok, fail } from "@/server/http";
import { requireWorkspaceOwner } from "@/integrations/call-workspace/http";
import { webReplitConnection } from "@/integrations/backend/replit-web";
import { BackendConfigurationError } from "@/integrations/backend/queue";

export const POST = handle(async (req: Request) => {
  const owner = requireWorkspaceOwner(req); let connection: ReturnType<typeof webReplitConnection> | undefined;
  try { connection = webReplitConnection(); return ok(await connection.service.begin(owner.ownerId)); }
  catch (error) { return fail(503, "NOT_READY", error instanceof BackendConfigurationError ? error.code : "Replit connection could not start. Retry from authenticated settings."); }
  finally { connection?.store.close(); }
});
