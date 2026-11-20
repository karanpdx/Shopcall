import { z } from "zod";
import { getDb } from "../src/server/db";
import { repository } from "../src/server/repository";
import { SqliteBackendJobSource } from "../src/integrations/backend/source";
import { FileBuildRunStore } from "../src/integrations/publication/store";
import { PublicationWorkflow } from "../src/integrations/publication/workflow";

// Trusted local operator recovery after fixing a source inspection failure.
// No remote mutations or acceptance evidence are produced by this command.
const id = z.uuid().parse(process.argv[2]);
const source = new SqliteBackendJobSource(getDb(), repository());
const spec = await source.getSpec(id);
if (!spec) throw new Error("Approved build snapshot not found.");
await source.assertOwnerJob(spec.approvedByOwnerId, spec.businessId, id);
const unexpected = async (): Promise<never> => { throw new Error("Recovery must not contact Replit."); };
const workflow = new PublicationWorkflow(new FileBuildRunStore(), source, {
  createApp: unexpected, updateApp: unexpected, observeTask: unexpected, publishApp: unexpected, observePublish: unexpected,
}, { verify: unexpected });
try {
  const run = await workflow.resumeSourceObservation(id, { ownerUserId: spec.approvedByOwnerId, businessId: spec.businessId, approvalId: id });
  console.log(JSON.stringify({ jobId: run.id, phase: run.phase, task: run.currentTaskId, existingAppPreserved: !!run.replId, remoteMutations: 0 }));
} catch {
  console.error("Source observation recovery rejected. Check owner/snapshot and the exact blocked reason; uncertain provider mutations require separate reconciliation.");
  process.exitCode = 1;
}
