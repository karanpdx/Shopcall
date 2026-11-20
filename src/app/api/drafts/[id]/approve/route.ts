import { requireOwner } from "@/server/auth";
import { handle, ok, type IdParams } from "@/server/http";
import { repository } from "@/server/repository";

/** Owner-UI approval only. Do not expose to voice-agent client tools. */
export const POST = handle(async (req: Request, { params }: IdParams) => {
  const { businessId } = requireOwner(req);
  return ok(await repository().approveDraft(businessId, (await params).id));
});
