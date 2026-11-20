import { requireOwner } from "@/server/auth";
import { fail, handle, ok } from "@/server/http";
import { repository } from "@/server/repository";

export const GET = handle(async (req: Request) => {
  const { businessId } = requireOwner(req);
  return ok((await repository().getBusiness(businessId)) ?? fail(404, "NOT_FOUND", "Business not found"));
});
