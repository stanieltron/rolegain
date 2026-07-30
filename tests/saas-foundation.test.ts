import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JobSearchService } from "../src/backend/control-flow/service.js";
import type { JobSearchWorkspace } from "../src/contracts/job-search.js";
import type { WorkspaceStore } from "../src/backend/persistence/workspace-store.js";
import {
  MemoryTokenCounter,
  totalTokens,
} from "../src/backend/usage/token-counter.js";
import type { CodexRunObservation } from "../src/codex-runtime/client.js";
import { runtimeConfiguration } from "../src/config/runtime.js";

describe("commercial SaaS foundation", () => {
  it("keeps independently persisted workspaces isolated by authenticated user", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rolegain-tenants-"));
    const service = new JobSearchService(root);
    await service.initialize({ defaultCandidateId: false });

    await service.updateProfile(
      { name: "Alice", email: "alice@example.com" },
      { deferEvidenceAnalysis: true },
      "user-a",
    );
    await service.updateProfile(
      { name: "Bob", email: "bob@example.com" },
      { deferEvidenceAnalysis: true },
      "user-b",
    );

    expect((await service.get("user-a")).profile.name).toBe("Alice");
    expect((await service.get("user-b")).profile.name).toBe("Bob");

    await service.resetUserCompletely("user-a");
    expect((await service.get("user-a")).profile.name).toBe("");
    expect((await service.get("user-b")).profile.name).toBe("Bob");
  });

  it("refreshes workspaces changed by another service process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rolegain-shared-"));
    const store = new SharedMemoryWorkspaceStore();
    const first = new JobSearchService(
      path.join(root, "first"),
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );
    const second = new JobSearchService(
      path.join(root, "second"),
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );
    await Promise.all([
      first.initialize({ defaultCandidateId: false }),
      second.initialize({ defaultCandidateId: false }),
    ]);

    await first.updateProfile(
      { name: "Before", email: "user@example.com" },
      { deferEvidenceAnalysis: true },
      "shared-user",
    );
    expect((await second.get("shared-user")).profile.name).toBe("Before");

    await first.updateProfile(
      { name: "After", email: "user@example.com" },
      { deferEvidenceAnalysis: true },
      "shared-user",
    );
    expect((await second.get("shared-user")).profile.name).toBe("After");
  });

  it("increments one simple token total and deduplicates completion callbacks", async () => {
    const counter = new MemoryTokenCounter();
    const observation = runObservation({
      prompt_tokens: 120,
      completion_tokens: 30,
    });

    await counter.record({ userId: "user-a" }, observation);
    await counter.record({ userId: "user-a" }, observation);
    await counter.record(
      { userId: "user-b" },
      runObservation({ totalTokenCount: 22 }, "turn-2"),
    );

    expect(await counter.get("user-a")).toEqual({ totalTokens: 150 });
    expect(await counter.get("user-b")).toEqual({ totalTokens: 22 });
  });

  it("normalizes common provider total-token response shapes", () => {
    expect(totalTokens({ total_tokens: 9 })).toBe(9);
    expect(totalTokens({ totalTokenCount: 10 })).toBe(10);
    expect(totalTokens({ input_tokens: 6, output_tokens: 7 })).toBe(13);
  });

  it("requires production credentials only in Supabase mode", () => {
    expect(runtimeConfiguration({}).authMode).toBe("local");
    expect(() =>
      runtimeConfiguration({ ROLEGAIN_AUTH_MODE: "supabase" }),
    ).toThrow("DATABASE_URL is required");
  });
});

class SharedMemoryWorkspaceStore implements WorkspaceStore {
  private readonly values = new Map<string, JobSearchWorkspace>();

  async initialize() {}

  async load(userId: string) {
    const value = this.values.get(userId);
    return value ? structuredClone(value) : undefined;
  }

  async save(workspace: JobSearchWorkspace) {
    this.values.set(workspace.candidateId, structuredClone(workspace));
  }

  async delete(userId: string) {
    this.values.delete(userId);
  }
}

function runObservation(
  usage: Record<string, unknown>,
  turnId = "turn-1",
): CodexRunObservation {
  return {
    threadId: "thread-1",
    turnId,
    callId: "test.call",
    role: "test",
    model: "test-model",
    status: "completed",
    runDirectory: "test",
    durationMs: 1,
    usage,
  };
}
