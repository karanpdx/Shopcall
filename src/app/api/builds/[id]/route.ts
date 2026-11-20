import { requireOwner } from "@/server/auth";
import { fail, handle, ok, type IdParams } from "@/server/http";
import { repository } from "@/server/repository";
import { getBackendBuildStatus } from "@/integrations/backend/runtime";

export const GET = handle(async (req: Request, { params }: IdParams) => {
  const owner = requireOwner(req);
  return ok(await getBackendBuildStatus(owner, (await params).id));
});
