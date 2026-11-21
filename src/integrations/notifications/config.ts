export type NotificationConfig = {
  resendApiKey: string;
  /** "Shopcall <notify@your-verified-domain>" — domain must be verified in Resend. */
  from: string;
  replyTo?: string;
  resendBaseUrl: string;
};

const REQUIRED = ["RESEND_API_KEY", "EMAIL_FROM"] as const;
const FROM_PATTERN = /^(?:[^<>\r\n]{1,100} )?<?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/;

type Env = Record<string, string | undefined>;

/** Reports configuration presence only; never returns secret values. */
export function getNotificationHealth(env: Env = process.env): { configured: boolean; missing: string[] } {
  const missing = REQUIRED.filter(name => !env[name]?.trim());
  return { configured: missing.length === 0, missing: [...missing] };
}

export function loadNotificationConfig(env: Env = process.env): NotificationConfig {
  const { configured, missing } = getNotificationHealth(env);
  if (!configured) throw new Error(`Email notifications not configured; missing: ${missing.join(", ")}`);
  const from = env.EMAIL_FROM!.trim();
  if (!FROM_PATTERN.test(from)) throw new Error("EMAIL_FROM must be an address or 'Name <address>'");
  const replyTo = env.EMAIL_REPLY_TO?.trim() || undefined;
  if (replyTo && !isEmailAddress(replyTo)) throw new Error("EMAIL_REPLY_TO must be an email address");
  return {
    resendApiKey: env.RESEND_API_KEY!.trim(),
    from,
    replyTo,
    resendBaseUrl: "https://api.resend.com",
  };
}

export function isEmailAddress(value: string): boolean {
  return value.length <= 254 && /^[^\s<>@"',;]+@[^\s<>@"',;]+\.[A-Za-z]{2,}$/.test(value);
}
