import { z } from "zod";
import { fail, handle, ok, HttpError } from "../../server/http";
import { readWorkspaceJson, requireWorkspaceOwner } from "./http";
import { issueVoiceSession, VoiceIntegrationError } from "../elevenlabs/service";
import type { CallWorkspaceService } from "./service";

/** Inject provider issuance for deterministic route tests; production uses real SDK adapter. */
export function createVoiceSessionHandler(deps: { workspace: () => CallWorkspaceService; issue?: typeof issueVoiceSession }) {
  return handle(async (req: Request) => {
    const owner = requireWorkspaceOwner(req);
    const { callId } = z.object({ callId: z.uuid() }).strict().parse(await readWorkspaceJson(req));
    const workspace = deps.workspace();
    workspace.store.reserveVoiceAttempt(owner, callId);
    try {
      const session = await (deps.issue ?? issueVoiceSession)({ ownerUserId: owner.ownerId, businessId: owner.businessId, callId }, {
        assertOwnerCall: async context => { workspace.store.assertActive({ ownerId: context.ownerUserId, businessId: context.businessId }, context.callId); },
      });
      workspace.store.assertActive(owner, callId);
      return ok(session);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof VoiceIntegrationError) return fail(error.code === "UNAUTHORIZED" ? 401 : error.code === "PROVIDER_ERROR" ? 502 : 503, error.code === "CONFIG_MISMATCH" ? "CONFIGURATION_ERROR" : error.code, error.message);
      return fail(502, "PROVIDER_ERROR", "Unable to start voice session. Retry from the authenticated call page.");
    }
  });
}
