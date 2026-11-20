import { buildJobRequest } from "@/contracts/api";
import { requireOwner } from "@/server/auth";
import { fail, handle, ok } from "@/server/http";
import { repository } from "@/server/repository";

/** Persists a queued build request. Accepted ≠ built ≠ published; Lane C's worker claims and advances it. */
export const POST = handle(async (req: Request) => {
  const { businessId, ownerId } = requireOwner(req);
  const text = await req.text();
  let json: unknown = {};
  try {
    if (text) json = JSON.parse(text);
  } catch {
    fail(400, "INVALID_INPUT", "Request body must be valid JSON");
  }
  const body = buildJobRequest.parse(json);
  return ok(await repository().createBuildJob(businessId, ownerId, body), { status: 202 });
});
