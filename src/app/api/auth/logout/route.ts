import { logout } from "@/server/auth";
import { handle, ok } from "@/server/http";

export const POST = handle(async (req: Request) => ok({ signedOut: true }, { headers: { "set-cookie": logout(req) } }));
