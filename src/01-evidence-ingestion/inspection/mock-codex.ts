import type {
  StartThreadOptions,
  StartTurnOptions,
} from "../../codex-runtime/client.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";

export interface RecordedModelCall {
  thread: StartThreadOptions;
  turn: StartTurnOptions;
}

/** Minimal deterministic Codex double shared by stage tests and serial runner. */
export function mockCodex(outputs: unknown[]) {
  const pending = [...outputs];
  const threads = new Map<string, StartThreadOptions>();
  const calls: RecordedModelCall[] = [];
  let nextThread = 1;
  const client = {
    async startThread(options: StartThreadOptions) {
      const id = `mock-thread-${nextThread++}`;
      threads.set(id, options);
      return { id, modelProvider: "mock" };
    },
    async runTurn(options: StartTurnOptions) {
      const thread = threads.get(options.threadId);
      if (!thread) throw new Error(`Unknown mock thread ${options.threadId}`);
      const wantsCoverage =
        thread.role === "candidate-source-coverage-verifier";
      const matchingIndex = pending.findIndex((candidate) =>
        wantsCoverage ? isCoverageOutput(candidate) : !isCoverageOutput(candidate),
      );
      const output =
        matchingIndex >= 0
          ? pending.splice(matchingIndex, 1)[0]
          : pending.shift();
      if (output === undefined) throw new Error("No mock LLM output remains");
      calls.push({ thread, turn: options });
      return {
        threadId: options.threadId,
        turnId: `mock-turn-${calls.length}`,
        status: "completed" as const,
        finalText: JSON.stringify(output),
        items: [],
      };
    },
  } as unknown as CodexExecClient;
  return { client, calls, remaining: () => pending.length };
}

function isCoverageOutput(value: unknown) {
  return (
    typeof value === "object" &&
    value !== null &&
    "complete" in value &&
    "missingEvidence" in value &&
    "unsupportedExtractions" in value
  );
}
