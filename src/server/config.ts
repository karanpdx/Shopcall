import { fail } from "./http";

const isProduction = () => process.env.NODE_ENV === "production";

/**
 * Publicly reachable backend origin (PUBLIC_API_BASE), e.g. https://api.shopcall.example.
 * Generated storefronts fetch the catalog from here, so it must never be localhost in production.
 */
export function publicApiBase(): string {
  const raw = process.env.PUBLIC_API_BASE?.trim();
  if (!raw) return fail(503, "CONFIGURATION_ERROR", "PUBLIC_API_BASE is not configured; the public catalog URL cannot be built.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(503, "CONFIGURATION_ERROR", "PUBLIC_API_BASE is not a valid URL.");
  }
  if (isProduction()) {
    if (url.protocol !== "https:") fail(503, "CONFIGURATION_ERROR", "PUBLIC_API_BASE must use https in production.");
    if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(url.hostname)) fail(503, "CONFIGURATION_ERROR", "PUBLIC_API_BASE must not be a loopback host in production.");
  }
  return url.origin;
}

export const publicCatalogUrl = (slug: string) => `${publicApiBase()}/api/public/${encodeURIComponent(slug)}/catalog`;

/**
 * Absolute when PUBLIC_API_BASE is valid. Owner-facing callers fall back to a same-origin relative path so a
 * config problem never turns an already-persisted write into an error; the public catalog requires absolute.
 */
export function assetUrl(assetId: string, requireAbsolute = false): string {
  if (requireAbsolute) return `${publicApiBase()}/api/assets/${assetId}`;
  try {
    return `${publicApiBase()}/api/assets/${assetId}`;
  } catch {
    return `/api/assets/${assetId}`;
  }
}

export const uploadMaxBytes = () => Number(process.env.UPLOAD_MAX_BYTES) || 10 * 1024 * 1024;
