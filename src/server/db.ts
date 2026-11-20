import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fail } from "./http";

let db: Database.Database | undefined;

/**
 * Opens DATABASE_URL (SQLite file path, `file:` prefix optional, or `:memory:` for tests) and applies migrations.
 * shortcut: SQLite only (better-sqlite3 is the installed driver); hosted deployment needs a persistent volume,
 * or a Postgres driver from Lane C plus a port of repository.ts.
 */
export function getDb(): Database.Database {
  if (db) return db;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return fail(503, "CONFIGURATION_ERROR", "DATABASE_URL is not configured.");
  if (/^postgres(ql)?:/i.test(url)) {
    return fail(503, "CONFIGURATION_ERROR", "DATABASE_URL is Postgres, but no Postgres driver is installed. Use a SQLite file path.");
  }
  const file = url.replace(/^file:/, "");
  if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const conn = new Database(file);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.pragma("busy_timeout = 5000");
  migrate(conn);
  return (db = conn);
}

function migrate(conn: Database.Database) {
  conn.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const dir = path.join(process.cwd(), "migrations");
  for (const name of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) {
    conn.transaction(() => {
      if (conn.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name)) return;
      conn.exec(readFileSync(path.join(dir, name), "utf8"));
      conn.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
    }).immediate();
  }
}
