import { requireOwner } from "@/server/auth";
import { fail, handle, ok, type IdParams } from "@/server/http";
import { repository } from "@/server/repository";

export const GET = handle(async (req: Request, { params }: IdParams) => {
  const { businessId } = requireOwner(req);
  const product = await repository().getProduct(businessId, (await params).id);
  return ok(product ?? fail(404, "NOT_FOUND", "Product not found"));
});
