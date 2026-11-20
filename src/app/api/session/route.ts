import { requireOwner, toSession } from "@/server/auth";
import { handle, ok } from "@/server/http";

export const GET = handle(async (req: Request) => ok(toSession(requireOwner(req))));
