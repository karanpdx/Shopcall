import { requireOwner } from "@/server/auth";
import { handle, ok } from "@/server/http";
import { storeOriginalImage } from "@/server/uploads";

export const POST = handle(async (req: Request) => ok(await storeOriginalImage(req, requireOwner(req).businessId), { status: 201 }));
