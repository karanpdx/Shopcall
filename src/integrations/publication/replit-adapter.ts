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
  constructor(private readonly client: ReplitMcpPort, profile: ReplitResponseProfile, private readonly observer: TaskObserver) {
    // Fail before remote mutations when output schemas have not yet been discovered/verified.
    this.profile = responseProfileSchema.parse(profile);
  }
  async createApp(prompt: string) {
    const result = parseCreationResult(await this.client.createApp({ appDescription: prompt, app_stack: "react_website" }), this.profile);
    if (result.state !== "created") throw new Error("CREATION_OUTCOME_UNVERIFIED");
    return { replId: result.replId };
  }
  async updateApp(replId: string, prompt: string) { await this.client.updateApp(replId, prompt); }
  observeTask(run: BuildRun, task: StorefrontTask) { return this.observer.observe(run, task); }
  async publishApp(replId: string) { await this.client.publishApp(replId); }
  async observePublish(replId: string) {
    const result = parsePublishResult(await this.client.getPublishStatus(replId), this.profile);
    if (result.state === "blocked") return { state: "blocked" as const, code: "PUBLISH_SCHEMA_UNVERIFIED" };
    if (result.state === "failed") return { state: "failed" as const, code: "PROVIDER_PUBLISH_FAILED" };
    if (result.state === "ready") return result;
    return { state: "pending" as const };
  }
}
