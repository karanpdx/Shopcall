/** Server-only entry point. Do not import from client components. */
export { getNotificationHealth, loadNotificationConfig, type NotificationConfig } from "./config";
export { createResendClient, type ResendClient, type ResendClientOptions, type SendOutcome, type EmailEventOutcome } from "./resend";
export { escapeHtml, renderPublicationReadyEmail, validatePublicUrl } from "./template";
export { createInMemoryNotificationOutbox } from "./outbox-memory";
export { SqliteNotificationOutbox } from "./outbox-sqlite";
export {
  DEFAULT_RETRY_POLICY,
  enqueuePublicationReadyEmail,
  getPublicationNotificationStatus,
  processNotificationOutbox,
  refreshNotificationDeliveryStatus,
  type NotificationDeps,
  type ProcessSummary,
  type PublicationNotificationView,
  type RetryPolicy,
} from "./service";
export type * from "./types";
