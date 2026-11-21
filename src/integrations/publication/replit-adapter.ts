import type { ReplitMcpPort } from "../replit/client";
import { parseCreationResult, parsePublishResult, responseProfileSchema, type ReplitResponseProfile } from "../replit/results";
import type { BuildRun, ReplitBuildPort, TaskObservation } from "./workflow";
import type { StorefrontTask } from "../orchestrator";

/** Trusted backend verifier; must observe artifacts/preview, not promote Agent prose to evidence. */
export interface TaskObserver {
  observe(run: BuildRun, task: StorefrontTask): Promise<TaskObservation>;
}

export class ReplitPublicationAdapter implements ReplitBuildPort {
  private readonly profile: ReplitResponseProfile;
  constructor(private readonly client: ReplitMcpPort, profile: ReplitResponseProfile, private readonly observer: TaskObserver, private readonly registerPublication?: (url: string) => void) {
    // Fail before remote mutations when output schemas have not yet been discovered/verified.
    this.profile = responseProfileSchema.parse(profile);
  }
  async createApp(prompt: string) {
    const result = parseCreationResult(await this.client.createApp({ appDescription: prompt, app_stack: "react_website" }), this.profile);
    if (result.state !== "created") throw new Error("CREATION_OUTCOME_UNVERIFIED");
    return { replId: result.replId };
  }
  async updateApp(replId: string, prompt: string) { await this.client.updateApp(replId, prompt); }
  observeTask(run: BuildRun, task: StorefrontTask): Promise<TaskObservation> {
    if (task.id === "qa" && run.phase === "verifying") {
      // A worker reconstructs this adapter each tick. Restore the exact published
      // origin from durable provider evidence, rather than relying on the prior
      // publish-status tick's in-memory allowlist mutation.
      const published = run.candidateUrl && run.evidence.some(entry => entry.taskId === "deploy" && entry.source === "provider-publish-status" && entry.outcome === "passed" && entry.replId === run.replId && entry.planId === run.plan.id && entry.artifactRef === run.candidateUrl && entry.checks.includes("provider-published"));
      if (!published) return Promise.resolve({ state: "blocked", code: "PUBLICATION_PROVENANCE_REQUIRED" });
      this.registerPublication?.(run.candidateUrl!);
    }
    return this.observer.observe(run, task);
  }
  async publishApp(replId: string) { await this.client.publishApp(replId); }
  async observePublish(replId: string) {
    const result = parsePublishResult(await this.client.getPublishStatus(replId), this.profile);
    if (result.state === "blocked") return { state: "blocked" as const, code: "PUBLISH_SCHEMA_UNVERIFIED" };
    if (result.state === "failed") return { state: "failed" as const, code: "PROVIDER_PUBLISH_FAILED" };
    if (result.state === "ready") { this.registerPublication?.(result.publicUrl); return result; }
    return { state: "pending" as const };
  }
}
