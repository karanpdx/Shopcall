/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Removes control characters (incl. CR/LF) and collapses whitespace for single-line fields. */
export function singleLine(value: string, max: number): string {
  const cleaned = Array.from(value, ch => (isControl(ch) ? " " : ch)).join("").replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function isControl(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return c <= 0x1f || c === 0x7f || c === 0x2028 || c === 0x2029;
}

/**
 * Validates a storefront URL for inclusion in email. Returns the normalized
 * href or null. Rules: https only, no credentials, real hostname, ≤2048 chars.
 */
export function validatePublicUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  if (/[\s<>"'`\\]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname;
  if (!host.includes(".") || host.endsWith(".")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  return url.href;
}

export type PublicationReadyContent = {
  businessName: string;
  publicUrl: string;
  catalogRevision: number;
};

export function renderPublicationReadyEmail(input: PublicationReadyContent): { subject: string; html: string; text: string } {
  const url = validatePublicUrl(input.publicUrl);
  if (!url) throw new Error("renderPublicationReadyEmail requires a validated https URL");
  const name = singleLine(input.businessName, 120) || "Your store";
  const subject = singleLine(`Your Shopcall storefront is live: ${name}`, 180);
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(url);
  const html = [
    "<!doctype html>",
    '<html><body style="font-family:system-ui,-apple-system,sans-serif;color:#111;line-height:1.5">',
    `<p>Good news — <strong>${safeName}</strong> is published and was verified as publicly reachable.</p>`,
    `<p><a href="${safeUrl}">${safeUrl}</a></p>`,
    `<p style="color:#555;font-size:13px">Catalog revision ${input.catalogRevision}. Prices and stock load live from your catalog, so future updates appear at the same address.</p>`,
    "</body></html>",
  ].join("");
  const text = [
    `Good news — ${name} is published and was verified as publicly reachable.`,
    "",
    url,
    "",
    `Catalog revision ${input.catalogRevision}. Prices and stock load live from your catalog, so future updates appear at the same address.`,
  ].join("\n");
  return { subject, html, text };
}
