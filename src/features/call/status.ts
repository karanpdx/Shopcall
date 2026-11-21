import type { BuildJob, BuildPhase } from "../../contracts/integrations";

export const PHASE_ORDER: BuildPhase[] = ["queued", "preparing", "creating", "building", "publishing", "verifying", "ready"];

export const isTerminal = (p: BuildPhase) => p === "ready" || p === "failed";

/** A public link is shown only when the job is ready with a URL. No other phase exposes one. */
export function verifiedUrl(job: Pick<BuildJob, "phase" | "publicUrl">): string | null {
  if (job.phase !== "ready" || !job.publicUrl) return null;
  try {
    const u = new URL(job.publicUrl);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export type StepState = "done" | "current" | "todo" | "failed";

export function phaseSteps(phase: BuildPhase): { phase: BuildPhase; state: StepState }[] {
  if (phase === "failed") return [...PHASE_ORDER.slice(0, -1).map(p => ({ phase: p, state: "todo" as StepState })), { phase: "failed", state: "failed" }];
  const idx = PHASE_ORDER.indexOf(phase);
  return PHASE_ORDER.map((p, i) => ({ phase: p, state: i < idx ? "done" : i === idx ? (p === "ready" ? "done" : "current") : "todo" }));
}
