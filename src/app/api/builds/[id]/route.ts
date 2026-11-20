import { requireOwner } from "@/server/auth";
import { fail, handle, ok, type IdParams } from "@/server/http";
import { repository } from "@/server/repository";

export const GET = handle(async (req: Request, { params }: IdParams) => {
  const { businessId } = requireOwner(req);
  return ok((await repository().getBuildJob(businessId, (await params).id)) ?? fail(404, "NOT_FOUND", "Build job not found"));
});
