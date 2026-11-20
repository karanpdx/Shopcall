import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BuildRun, BuildRunStore } from "./workflow";

const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Local durable adapter. Production hosts must mount a persistent volume or supply a DB adapter. */
export class FileBuildRunStore implements BuildRunStore {
  constructor(private readonly directory = ".shopcall/build-runs") {}

  private path(id: string) {
    if (!validId.test(id)) throw new Error("Build run ID must be a UUID.");
    return join(this.directory, `${id}.json`);
  }

  async load(id: string): Promise<BuildRun | null> {
    try { return JSON.parse(await readFile(this.path(id), "utf8")) as BuildRun; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(run: BuildRun) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.path(run.id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(run, null, 2));
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, destination);
  }

  async withLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = await open(`${this.path(id)}.lock`, "wx", 0o600).catch(error => {
      if (error.code === "EEXIST") throw new Error("RUN_LOCKED: another worker owns this run; crashed workers require reconciliation before lock removal.");
      throw error;
    });
    try { return await action(); }
    finally {
      await lock.close();
      await unlink(`${this.path(id)}.lock`);
    }
  }

  async reserveBusiness(businessId: string, runId: string) {
    const reservation = `${this.path(businessId)}.active`;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const file = await open(reservation, "wx", 0o600);
      try { await file.writeFile(runId); await file.sync(); } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await readFile(reservation, "utf8") !== runId) throw new Error("BUSINESS_BUILD_ACTIVE");
    }
  }

  async releaseBusiness(businessId: string, runId: string) {
    const reservation = `${this.path(businessId)}.active`;
    try {
      if (await readFile(reservation, "utf8") !== runId) throw new Error("BUSINESS_RESERVATION_MISMATCH");
      await unlink(reservation);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
