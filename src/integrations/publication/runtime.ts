import type { Browser } from "playwright-core";
import { AutomaticStorefrontTaskObserver, PlaywrightPreviewInspector } from "../orchestrator";
import { ReplitArtifactTaskObserver } from "../replit/artifact-observer";
import { createResendClient, type NotificationConfig, type NotificationOutboxRepository } from "../notifications";
import type { ReplitMcpPort, ReplitArtifactPort } from "../replit/client";
import type { ReplitResponseProfile } from "../replit/results";
import { ReplitPublicationAdapter } from "./replit-adapter";
import { AnonymousStorefrontVerifier, PlaywrightStorefrontCheck } from "./verification";
import { PublicationWorkflow, type BuildRunStore, type PublicationAuthorization } from "./workflow";
import { PublicationNotificationWorker, WorkflowPublicationSource, type VerifiedOwnerDirectory } from "./notifications";

export type PublicationRuntimeOptions = {
  runs: BuildRunStore;
  authorization: PublicationAuthorization;
  owners: VerifiedOwnerDirectory;
  replit: ReplitMcpPort & ReplitArtifactPort;
  responseProfile: ReplitResponseProfile;
  /** Fixed deployment configuration: storefront/preview, canonical backend, public storage origins. */
  trustedOrigins: readonly string[];
  launchBrowser?: () => Promise<Browser>;
  notification?: { config: NotificationConfig; outbox: NotificationOutboxRepository };
  now?: () => Date;
  closeStorage?: () => Promise<void>;
};

/** B supplies auth/persistence boundaries; C composes actual provider/task/browser/email implementations. */
export function composePublicationRuntime(options: PublicationRuntimeOptions) {
  const now = options.now ?? (() => new Date());
  const origins = [...options.trustedOrigins];
  const verifier = new AnonymousStorefrontVerifier(origins, new PlaywrightStorefrontCheck(options.launchBrowser), fetch, now);
  const browserObserver = new AutomaticStorefrontTaskObserver({ async locate() { return null; } }, new PlaywrightPreviewInspector(origins, verifier, fetch, options.launchBrowser, now), now);
  const artifactObserver = new ReplitArtifactTaskObserver(options.replit, now);
  const observer = { observe: (run: Parameters<typeof artifactObserver.observe>[0], task: Parameters<typeof artifactObserver.observe>[1]) => task.id === "qa" ? browserObserver.observe(run, task) : artifactObserver.observe(run, task) };
  const replit = new ReplitPublicationAdapter(options.replit, options.responseProfile, observer, value => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || url.search || !(url.hostname.endsWith(".replit.app") || origins.includes(url.origin))) throw new Error("Provider publication origin is not allowed.");
    if (!origins.includes(url.origin)) origins.push(url.origin);
  });
  const workflow = new PublicationWorkflow(options.runs, options.authorization, replit, verifier, now);
  const publicationSource = new WorkflowPublicationSource(options.runs, options.owners);
  const notifications = options.notification ? new PublicationNotificationWorker({
    outbox: options.notification.outbox,
    publications: publicationSource,
    sender: { from: options.notification.config.from, replyTo: options.notification.config.replyTo },
    resend: createResendClient({ apiKey: options.notification.config.resendApiKey, baseUrl: options.notification.config.resendBaseUrl }),
    clock: now,
  }) : undefined;
  return {
    workflow,
    notifications,
    publicationSource,
    async close() { try { await options.replit.close(); } finally { await options.closeStorage?.(); } },
  };
}
