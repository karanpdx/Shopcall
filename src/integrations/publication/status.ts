import type { BuildJob, BuildPhase } from "../../contracts/integrations";
import type { BuildRun } from "./workflow";

/** B must authenticate owner access before returning this projection. Never serialize a whole BuildRun. */
export function toOwnerBuildStatus(run: BuildRun) {
  let phase: BuildPhase;
  switch (run.phase) {
    case "queued": phase = "queued"; break;
    case "dispatching": phase = run.replId ? "building" : "creating"; break;
    case "awaiting_task":
    case "ready_to_publish": phase = "building"; break;
    case "publishing": phase = "publishing"; break;
    case "verifying": phase = "verifying"; break;
    case "ready": phase = "ready"; break;
    case "blocked":
    case "failed": phase = "failed"; break;
  }
  const job: BuildJob = {
    id: run.id, businessId: run.approval.businessId, phase, replId: run.replId,
    publicUrl: run.phase === "ready" ? run.publicUrl : null,
    error: run.errorCode, createdAt: run.createdAt, updatedAt: run.updatedAt,
  };
  const task = run.plan.tasks.find(task => task.id === run.currentTaskId);
  return { job, task: task ? { id: task.id, role: task.role } : null, blocked: run.phase === "blocked", requiresReconciliation: run.phase === "blocked" };
}
