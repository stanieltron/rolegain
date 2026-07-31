import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendDiagnosticEvent,
  diagnosticLogRoot,
  initializeDiagnosticLog,
} from "../src/diagnostics/run-log.js";
import { llmRunRoot } from "../src/llm-runtime/run-root.js";

describe("local diagnostic run paths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the historical LLM trace path by default", () => {
    vi.stubEnv("ROLEGAIN_LLM_RUN_ROOT", "");
    expect(llmRunRoot("C:\\workspace")).toBe(
      path.join("C:\\workspace", ".agent-runtime", "runs"),
    );
  });

  it("writes session metadata and structured events to an isolated root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-diagnostic-"));
    vi.stubEnv("ROLEGAIN_DIAGNOSTIC_LOG_ROOT", root);
    vi.stubEnv("ROLEGAIN_LLM_RUN_ROOT", path.join(root, "llm-calls"));

    expect(diagnosticLogRoot()).toBe(root);
    expect(llmRunRoot(process.cwd())).toBe(path.join(root, "llm-calls"));

    await initializeDiagnosticLog({ mode: "test" });
    await appendDiagnosticEvent("test-event", { value: 42 });

    expect(JSON.parse(await readFile(path.join(root, "session.json"), "utf8")))
      .toEqual({ mode: "test" });
    const event = JSON.parse(
      (await readFile(path.join(root, "diagnostic-events.jsonl"), "utf8")).trim(),
    );
    expect(event).toMatchObject({
      category: "test-event",
      value: 42,
    });
    expect(event.timestamp).toBeTypeOf("string");
  });
});
