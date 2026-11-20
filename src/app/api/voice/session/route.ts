import { callWorkspace } from "@/integrations/call-workspace/runtime";
import { createVoiceSessionHandler } from "@/integrations/call-workspace/session";

export const POST = createVoiceSessionHandler({ workspace: callWorkspace });
