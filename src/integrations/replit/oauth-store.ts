import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

export type OAuthConnection = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
};
export type OAuthAttempt = { state: string; verifier?: string; expiresAt: number };

/** Implement the same atomic semantics with hosted storage for multi-instance deployment. */
export interface ReplitOAuthStore {
  getConnection(ownerId: string): Promise<OAuthConnection>;
  updateConnection(ownerId: string, patch: (current: OAuthConnection) => OAuthConnection): Promise<void>;
  putAttempt(ownerId: string, attempt: OAuthAttempt): Promise<void>;
  getAttempt(ownerId: string): Promise<OAuthAttempt | undefined>;
  updateVerifier(ownerId: string, state: string, verifier: string): Promise<void>;
  /** Atomically validate owner/state/expiry, remove attempt, and return it. */
  consumeAttempt(ownerId: string, state: string, now: number): Promise<OAuthAttempt | undefined>;
}

function ownerKey(ownerId: string) {
  if (!ownerId || ownerId.length > 200) throw new Error("Invalid authenticated owner ID.");
  return createHash("sha256").update(ownerId).digest("hex");
}

/** Durable for a single persistent volume; never use on an ephemeral deployment disk. */
export class EncryptedFileOAuthStore implements ReplitOAuthStore {
  private readonly db: Database.Database;
  private readonly key: Buffer;
  constructor(path: string, encryptionKeyBase64: string) {
    this.key = Buffer.from(encryptionKeyBase64, "base64");
    if (this.key.length !== 32) throw new Error("Replit credential encryption key must contain 32 random bytes encoded as base64.");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    chmodSync(path, 0o600);
    // DELETE journal avoids long-lived plaintext metadata sidecar permissions concerns.
    this.db.pragma("journal_mode = DELETE");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec("CREATE TABLE IF NOT EXISTS replit_credentials (owner TEXT PRIMARY KEY, connection TEXT NOT NULL); CREATE TABLE IF NOT EXISTS replit_attempts (owner TEXT PRIMARY KEY, state_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, payload TEXT NOT NULL)");
  }
  close() { this.db.close(); }
  private seal(value: unknown, aad: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }
  private open<T>(payload: string, aad: string): T {
    try {
      const bytes = Buffer.from(payload, "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")) as T;
    } catch { throw new Error("Replit credential store could not be decrypted."); }
  }
  private readConnection(owner: string): OAuthConnection {
    const row = this.db.prepare("SELECT connection FROM replit_credentials WHERE owner = ?").get(owner) as { connection: string } | undefined;
    return row ? this.open<OAuthConnection>(row.connection, `connection:${owner}`) : {};
  }
  async getConnection(ownerId: string) { return this.readConnection(ownerKey(ownerId)); }
  async updateConnection(ownerId: string, patch: (current: OAuthConnection) => OAuthConnection) {
    const owner = ownerKey(ownerId);
    this.db.transaction(() => {
      const next = patch(this.readConnection(owner));
      this.db.prepare("INSERT INTO replit_credentials(owner, connection) VALUES (?, ?) ON CONFLICT(owner) DO UPDATE SET connection = excluded.connection").run(owner, this.seal(next, `connection:${owner}`));
    }).immediate();
  }
  async putAttempt(ownerId: string, attempt: OAuthAttempt) {
    const owner = ownerKey(ownerId);
    this.db.prepare("INSERT INTO replit_attempts(owner, state_hash, expires_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(owner) DO UPDATE SET state_hash=excluded.state_hash, expires_at=excluded.expires_at, payload=excluded.payload").run(owner, ownerKey(attempt.state), attempt.expiresAt, this.seal(attempt, `attempt:${owner}`));
  }
  async getAttempt(ownerId: string) {
    const owner = ownerKey(ownerId);
    const row = this.db.prepare("SELECT payload FROM replit_attempts WHERE owner = ?").get(owner) as { payload: string } | undefined;
    return row ? this.open<OAuthAttempt>(row.payload, `attempt:${owner}`) : undefined;
  }
  async updateVerifier(ownerId: string, state: string, verifier: string) {
    const owner = ownerKey(ownerId);
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT payload FROM replit_attempts WHERE owner = ? AND state_hash = ?").get(owner, ownerKey(state)) as { payload: string } | undefined;
      if (!row) throw new Error("Replit OAuth attempt was replaced or expired. Reconnect.");
      const attempt = this.open<OAuthAttempt>(row.payload, `attempt:${owner}`);
      this.db.prepare("UPDATE replit_attempts SET payload = ? WHERE owner = ? AND state_hash = ?").run(this.seal({ ...attempt, verifier }, `attempt:${owner}`), owner, ownerKey(state));
    }).immediate();
  }
  async consumeAttempt(ownerId: string, state: string, now: number) {
    const owner = ownerKey(ownerId);
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT payload FROM replit_attempts WHERE owner = ? AND state_hash = ? AND expires_at > ?").get(owner, ownerKey(state), now) as { payload: string } | undefined;
      if (!row) return undefined;
      this.db.prepare("DELETE FROM replit_attempts WHERE owner = ?").run(owner);
      return this.open<OAuthAttempt>(row.payload, `attempt:${owner}`);
    }).immediate();
  }
}
