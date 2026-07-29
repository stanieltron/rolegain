import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as tar from "tar";
import { safeUserId } from "./workspace-store.js";

export interface ArtifactArchive {
  initialize(): Promise<void>;
  restore(userId: string): Promise<void>;
  snapshot(userId: string): Promise<void>;
  delete(userId: string): Promise<void>;
}

export class LocalArtifactArchive implements ArtifactArchive {
  async initialize() {}
  async restore(_userId: string) {}
  async snapshot(_userId: string) {}
  async delete(_userId: string) {}
}

export class SupabaseArtifactArchive implements ArtifactArchive {
  private readonly client: SupabaseClient;

  constructor(
    private readonly dataRoot: string,
    supabaseUrl: string,
    serviceRoleKey: string,
    private readonly bucket: string,
  ) {
    this.client = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  }

  async initialize() {
    const { data, error } = await this.client.storage.getBucket(this.bucket);
    if (data) return;
    if (error && !/not found/i.test(error.message)) throw error;
    const created = await this.client.storage.createBucket(this.bucket, {
      public: false,
      fileSizeLimit: 100 * 1024 * 1024,
      allowedMimeTypes: ["application/gzip"],
    });
    if (created.error && !isAlreadyExistsError(created.error))
      throw created.error;
  }

  async restore(userId: string) {
    const safe = safeUserId(userId);
    const result = await this.client.storage
      .from(this.bucket)
      .download(this.objectKey(safe));
    if (result.error) {
      if (/not found|does not exist/i.test(result.error.message)) return;
      throw result.error;
    }
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "rolegain-restore-"),
    );
    const archive = path.join(temporaryRoot, "artifacts.tgz");
    try {
      await mkdir(this.dataRoot, { recursive: true });
      await writeFile(
        archive,
        Buffer.from(await result.data.arrayBuffer()),
      );
      await tar.x({
        cwd: this.dataRoot,
        file: archive,
        gzip: true,
        strict: true,
        preservePaths: false,
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  async snapshot(userId: string) {
    const safe = safeUserId(userId);
    const paths = (
      await Promise.all(
        candidateArtifactPaths(safe).map(async (relative) =>
          (await stat(path.join(this.dataRoot, relative)).catch(() => null))
            ? relative
            : undefined,
        ),
      )
    ).filter((relative): relative is string => Boolean(relative));
    if (paths.length === 0) {
      await this.delete(safe);
      return;
    }
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "rolegain-snapshot-"),
    );
    const archive = path.join(temporaryRoot, "artifacts.tgz");
    try {
      await tar.c(
        {
          cwd: this.dataRoot,
          file: archive,
          gzip: true,
          portable: true,
        },
        paths,
      );
      const upload = await this.client.storage
        .from(this.bucket)
        .upload(this.objectKey(safe), await readFile(archive), {
          contentType: "application/gzip",
          upsert: true,
        });
      if (upload.error) throw upload.error;
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  async delete(userId: string) {
    const result = await this.client.storage
      .from(this.bucket)
      .remove([this.objectKey(safeUserId(userId))]);
    if (result.error) throw result.error;
  }

  private objectKey(userId: string) {
    return `users/${userId}/artifacts.tgz`;
  }
}

function isAlreadyExistsError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    message?: unknown;
    statusCode?: unknown;
  };
  return (
    String(value.statusCode ?? "") === "409" ||
    /already exists|duplicate/i.test(String(value.message ?? ""))
  );
}

function candidateArtifactPaths(userId: string) {
  return [
    path.join("job-search", "candidates", userId),
    path.join("job-search", "files", userId),
    path.join("job-search", "runs", userId),
    path.join("job-search", "source-snapshots", userId),
    path.join("job-search", "analysis-checkpoints", userId),
  ];
}
