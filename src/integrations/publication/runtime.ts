import type { Browser } from "playwright-core";
import { AutomaticStorefrontTaskObserver, PlaywrightPreviewInspector, type PreviewLocator } from "../orchestrator";
import { createResendClient, type NotificationConfig, type NotificationOutboxRepository } from "../notifications";
import type { ReplitMcpPort } from "../replit/client";
import type { ReplitResponseProfile } from "../replit/results";
import { ReplitPublicationAdapter } from "./replit-adapter";
import { AnonymousStorefrontVerifier, PlaywrightStorefrontCheck } from "./verification";
import { PublicationWorkflow, type BuildRunStore, type PublicationAuthorization } from "./workflow";
import { PublicationNotificationWorker, WorkflowPublicationSource, type VerifiedOwnerDirectory } from "./notifications";

export type PublicationRuntimeOptions = {
  runs: BuildRunStore;
  authorization: PublicationAuthorization;
  owners: VerifiedOwnerDirectory;
  replit: ReplitMcpPort;
  responseProfile: ReplitResponseProfile;
  previewLocator: PreviewLocator;
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
  const verifier = new AnonymousStorefrontVerifier(options.trustedOrigins, new PlaywrightStorefrontCheck(options.launchBrowser), fetch, now);
  const observer = new AutomaticStorefrontTaskObserver(options.previewLocator, new PlaywrightPreviewInspector(options.trustedOrigins, verifier, fetch, options.launchBrowser, now), now);
  const replit = new ReplitPublicationAdapter(options.replit, options.responseProfile, observer);
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
