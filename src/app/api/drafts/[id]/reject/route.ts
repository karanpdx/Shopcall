import { requireOwner } from "@/server/auth";
import { handle, ok, type IdParams } from "@/server/http";
import { repository } from "@/server/repository";

export const POST = handle(async (req: Request, { params }: IdParams) => {
  const { businessId } = requireOwner(req);
  return ok(await repository().rejectDraft(businessId, (await params).id));
});
