import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { JobSearchWorkspace } from "../../contracts/job-search.js";

export interface WorkspaceStore {
  initialize(): Promise<void>;
  load(userId: string): Promise<JobSearchWorkspace | undefined>;
  save(workspace: JobSearchWorkspace): Promise<void>;
  delete(userId: string): Promise<void>;
}

export class FileWorkspaceStore implements WorkspaceStore {
  constructor(private readonly directory: string) {}

  async initialize() {
    await mkdir(this.directory, { recursive: true });
  }

  async load(userId: string) {
    try {
      return JSON.parse(
        await readFile(this.file(userId), "utf8"),
      ) as JobSearchWorkspace;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(workspace: JobSearchWorkspace) {
    const target = this.file(workspace.candidateId);
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify(workspace, null, 2)}\n`,
        "utf8",
      );
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  delete(userId: string) {
    return rm(this.file(userId), { force: true });
  }

  private file(userId: string) {
    return path.join(this.directory, `${safeUserId(userId)}.json`);
  }
}

export class PostgresWorkspaceStore implements WorkspaceStore {
  constructor(private readonly pool: Pool) {}

  async initialize() {
    // Database migrations own schema creation.
  }

  async load(userId: string) {
    const result = await this.pool.query<{ payload: JobSearchWorkspace }>(
      "select payload from rolegain_workspaces where user_id = $1",
      [userId],
    );
    return result.rows[0]?.payload;
  }

  async save(workspace: JobSearchWorkspace) {
    await this.pool.query(
      `insert into rolegain_workspaces (user_id, payload, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (user_id) do update
       set payload = excluded.payload, updated_at = now()`,
      [workspace.candidateId, JSON.stringify(workspace)],
    );
  }

  async delete(userId: string) {
    await this.pool.query(
      "delete from rolegain_workspaces where user_id = $1",
      [userId],
    );
  }
}

export function safeUserId(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new Error("Invalid user identifier");
  return value;
}
