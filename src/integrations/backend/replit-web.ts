import { localReplitConnection } from "../replit/local";
import { ReplitOAuthService } from "../replit/oauth";
import { BackendConfigurationError } from "./queue";

export function webReplitConnection() {
  const callback = webReplitRedirectUri();
  const local = localReplitConnection();
  return { store: local.store, service: new ReplitOAuthService(local.store, callback), directory: local.directory };
}
export function webReplitRedirectUri(env: Record<string, string | undefined> = process.env) {
  const base = env.APP_BASE_URL;
  if (!base) throw new BackendConfigurationError("APP_BASE_URL_REQUIRED");
  if (env.NODE_ENV === "production" && !env.REPLIT_CREDENTIAL_KEY) throw new BackendConfigurationError("MANAGED_REPLIT_CREDENTIAL_KEY_REQUIRED");
  const callback = env.REPLIT_WEB_REDIRECT_URI || new URL("/api/replit/callback", base).href;
  const url = new URL(callback);
  if (url.origin !== new URL(base).origin || url.pathname !== "/api/replit/callback" || url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new BackendConfigurationError("REPLIT_WEB_CALLBACK_MISMATCH");
  return callback;
}
export function runtimeReplitOwner(ownerId: string, isConfiguredDemoOwner: boolean, env: Record<string, string | undefined> = process.env) {
  const alias = env.REPLIT_CONNECTION_OWNER_ID?.trim();
  if (!alias || alias === ownerId) return ownerId;
  if (env.NODE_ENV === "production" || !isConfiguredDemoOwner) throw new BackendConfigurationError("REPLIT_CONNECTION_OWNER_MISMATCH");
  return alias;
}
