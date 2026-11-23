import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexExecClient, type StartTurnOptions } from "../src/codex-runtime/client.js";
import type { CodexTurnResult } from "../src/codex-runtime/protocol.js";
import { isTransientProviderError, PROVIDER_FAILURE_MESSAGE, withProviderRetry } from "../src/llm-runtime/provider-retry.js";

afterEach(() => vi.useRealTimers());

describe("bounded provider retry", () => {
  it("recovers a transient failure without replaying successful work", async () => {
    vi.useFakeTimers();
    const attempt = vi.fn().mockRejectedValueOnce(new Error("LLM API request failed (503 Unavailable)")).mockResolvedValue("done");
    const result = withProviderRetry(attempt, () => undefined);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toBe("done");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("stops after two attempts with a useful message and diagnostic cause", async () => {
    vi.useFakeTimers();
    const cause = new Error("unexpected status 429 Too Many Requests");
    const attempt = vi.fn().mockRejectedValue(cause);
    const result = withProviderRetry(attempt, () => undefined);
    const assertion = expect(result).rejects.toMatchObject({ message: PROVIDER_FAILURE_MESSAGE, cause });
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it.each([
    "Workflow cancelled by user", "Background execution is stopped",
    "Codex is not authenticated", "unexpected status 401 Unauthorized",
    "invalid_json_schema", "usage limit reached", "quota exceeded",
    "Job page returned 503", "getaddrinfo ENOTFOUND employer.example",
  ])("does not retry non-provider or permanent failure: %s", async (message) => {
    const error = new Error(message);
    expect(isTransientProviderError(error)).toBe(false);
    const attempt = vi.fn().mockRejectedValue(error);
    await expect(withProviderRetry(attempt, () => undefined)).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("honours per-user cancellation during the backoff", async () => {
    vi.useFakeTimers();
    class Client extends CodexExecClient {
      attempts = 0;
      protected override async runTurnAttempt(): Promise<CodexTurnResult> {
        this.attempts += 1;
        throw new Error("unexpected status 503 Service Unavailable");
      }
    }
    const client = new Client();
    const thread = await client.startThread({ cwd: process.cwd(), role: "test", sandbox: "read-only", developerInstructions: "test", executionContext: { userId: "user" } });
    const result = client.runTurn({ threadId: thread.id } as StartTurnOptions);
    const assertion = expect(result).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(1_000);
    await client.pauseTurnsForUser("user");
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(client.attempts).toBe(1);
  });
});
