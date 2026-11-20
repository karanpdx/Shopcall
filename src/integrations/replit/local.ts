import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { EncryptedFileOAuthStore } from "./oauth-store";
import { ReplitOAuthService } from "./oauth";

/** CLI-only local configuration; production must supply a managed encryption key/store. */
export function localReplitConnection() {
  const directory = resolve(".shopcall");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyFile = resolve(directory, "replit.key");
  let key = process.env.REPLIT_CREDENTIAL_KEY;
  if (!key) {
    try { key = readFileSync(keyFile, "utf8").trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      key = randomBytes(32).toString("base64");
      try { writeFileSync(keyFile, key, { mode: 0o600, flag: "wx" }); }
      catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
        key = readFileSync(keyFile, "utf8").trim();
      }
    }
  }
  const store = new EncryptedFileOAuthStore(resolve(directory, "replit-oauth.sqlite"), key);
  const callback = process.env.REPLIT_REDIRECT_URI ?? "http://127.0.0.1:8788/api/replit/callback";
  return { store, service: new ReplitOAuthService(store, callback), directory };
}
