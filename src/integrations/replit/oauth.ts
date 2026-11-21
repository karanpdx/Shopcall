import { randomBytes } from "node:crypto";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthAttempt, ReplitOAuthStore } from "./oauth-store";

export const REPLIT_MCP_URL = "https://mcp.replit.com/server/mcp";

const boundedFetch: typeof fetch = (input, init) => fetch(input, {
  ...init,
  signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
});

function validateCallback(raw: string) {
  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    throw new Error("Replit OAuth callback must be a fixed HTTPS URL (HTTP localhost allowed for development).");
  }
  return url.toString();
}

/** Never construct from request-supplied owner IDs or callback URLs. */
export class ReplitOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  authorizationUrl?: string;
  constructor(private readonly ownerId: string, private readonly store: ReplitOAuthStore, callbackUrl: string, private readonly attempt?: OAuthAttempt) {
    if (!ownerId) throw new Error("Authenticated owner required.");
    this.redirectUrl = validateCallback(callbackUrl);
  }
  get clientMetadata() {
    return { client_name: "Shopcall", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  state() {
    if (!this.attempt) throw new Error("Replit authorization requires a fresh owner-bound connection attempt.");
    return this.attempt.state;
  }
  async clientInformation() { return (await this.store.getConnection(this.ownerId)).clientInformation; }
  async saveClientInformation(clientInformation: OAuthClientInformationMixed) { await this.store.updateConnection(this.ownerId, current => ({ ...current, clientInformation })); }
  async tokens() { return (await this.store.getConnection(this.ownerId)).tokens; }
  async saveTokens(tokens: OAuthTokens) { await this.store.updateConnection(this.ownerId, current => ({ ...current, tokens })); }
  async discoveryState() { return (await this.store.getConnection(this.ownerId)).discovery; }
  async saveDiscoveryState(discovery: OAuthDiscoveryState) { await this.store.updateConnection(this.ownerId, current => ({ ...current, discovery })); }
  async redirectToAuthorization(url: URL) {
    if (!this.attempt) throw new Error("Replit connection expired. Reconnect from authenticated settings.");
    if (url.protocol !== "https:") throw new Error("Replit authorization endpoint must use HTTPS.");
    this.authorizationUrl = url.toString();
  }
  async saveCodeVerifier(verifier: string) {
    if (!this.attempt) throw new Error("Replit authorization attempt missing.");
    await this.store.updateVerifier(this.ownerId, this.attempt.state, verifier);
    this.attempt.verifier = verifier;
  }
  async codeVerifier() {
    if (!this.attempt?.verifier) throw new Error("Replit PKCE verifier missing. Reconnect.");
    return this.attempt.verifier;
  }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    await this.store.updateConnection(this.ownerId, current => {
      if (scope === "all") return {};
      const next = { ...current };
      if (scope === "client") delete next.clientInformation;
      if (scope === "tokens") delete next.tokens;
      if (scope === "discovery") delete next.discovery;
      return next;
    });
    if (scope === "verifier" && this.attempt) this.attempt.verifier = undefined;
  }
}

export class ReplitOAuthService {
  readonly callbackUrl: string;
  constructor(private readonly store: ReplitOAuthStore, callbackUrl: string, private readonly authorize: typeof auth = auth, private readonly now: () => number = Date.now) {
    this.callbackUrl = validateCallback(callbackUrl);
  }
  provider(ownerId: string) { return new ReplitOAuthProvider(ownerId, this.store, this.callbackUrl); }
  async begin(ownerId: string): Promise<{ state: "connected" } | { state: "redirect"; authorizationUrl: string }> {
    const attempt: OAuthAttempt = { state: randomBytes(32).toString("base64url"), expiresAt: this.now() + 10 * 60_000 };
    await this.store.putAttempt(ownerId, attempt);
    const provider = new ReplitOAuthProvider(ownerId, this.store, this.callbackUrl, attempt);
    try {
      const result = await this.authorize(provider, { serverUrl: REPLIT_MCP_URL, fetchFn: boundedFetch });
      if (result === "AUTHORIZED") return { state: "connected" };
      if (!provider.authorizationUrl) throw new Error("Missing redirect.");
      return { state: "redirect", authorizationUrl: provider.authorizationUrl };
    } catch { throw new Error("Replit OAuth could not start. Verify account access and provider availability."); }
  }
  /** Caller must require the same authenticated owner session used by begin(). */
  async complete(ownerId: string, state: string, code: string): Promise<void> {
    if (!state || state.length > 200 || !code || code.length > 8192) throw new Error("Invalid Replit OAuth callback.");
    const attempt = await this.store.consumeAttempt(ownerId, state, this.now());
    if (!attempt?.verifier) throw new Error("Replit OAuth state is invalid, expired, or already used. Reconnect.");
    const provider = new ReplitOAuthProvider(ownerId, this.store, this.callbackUrl, attempt);
    try {
      const result = await this.authorize(provider, { serverUrl: REPLIT_MCP_URL, authorizationCode: code, fetchFn: boundedFetch });
      if (result !== "AUTHORIZED") throw new Error("Authorization incomplete.");
    } catch { throw new Error("Replit OAuth exchange failed. Start a new connection attempt."); }
  }
}
