import { requireOwner } from "@/server/auth";
import { handle, ok } from "@/server/http";
import { repository } from "@/server/repository";

export const GET = handle(async (req: Request) => ok(await repository().listProducts(requireOwner(req).businessId)));
