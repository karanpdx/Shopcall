import { handle, fail } from "@/server/http";
import { requireWorkspaceOwner } from "@/integrations/call-workspace/http";
import { webReplitConnection } from "@/integrations/backend/replit-web";

export const GET = handle(async (req: Request) => {
  const owner = requireWorkspaceOwner(req); const url = new URL(req.url);
  if (url.searchParams.has("error")) return fail(400, "NOT_READY", "Replit authorization was declined or failed. Start a new connection.");
  const state = url.searchParams.get("state"); const code = url.searchParams.get("code");
  if (!state || !code) return fail(400, "INVALID_INPUT", "Replit OAuth state and code are required.");
  let connection: ReturnType<typeof webReplitConnection> | undefined;
  try {
    connection = webReplitConnection(); await connection.service.complete(owner.ownerId, state, code);
    return Response.redirect(new URL("/?replit=connected", process.env.APP_BASE_URL), 303);
  } catch { return fail(400, "NOT_READY", "Replit connection could not complete. Start a new authenticated connection attempt."); }
  finally { connection?.store.close(); }
});
