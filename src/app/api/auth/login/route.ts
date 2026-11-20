import { login } from "@/server/auth";
import { handle, ok, readJson } from "@/server/http";

export const POST = handle(async (req: Request) => {
  const { session, setCookie } = await login(req, await readJson(req));
  return ok(session, { headers: { "set-cookie": setCookie } });
});
