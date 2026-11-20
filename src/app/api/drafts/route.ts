import { productChange } from "@/contracts/api";
import { requireOwner } from "@/server/auth";
import { handle, ok, readJson } from "@/server/http";
import { repository } from "@/server/repository";

export const POST = handle(async (req: Request) => {
  const { businessId } = requireOwner(req);
  const change = productChange.parse(await readJson(req));
  return ok(await repository().createDraft(businessId, change), { status: 201 });
});
