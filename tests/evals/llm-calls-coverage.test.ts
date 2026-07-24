import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { llmCallCatalog } from "../../src/backend/control-flow/llm-call-catalog.js";
import { LLM_EVAL_CASES } from "../../evals/llm-calls/src/cases.js";
import { evaluateFlowCoverage } from "../../evals/llm-calls/src/flows.js";
import { runLlmCallEval } from "../../evals/llm-calls/src/runner.js";

describe("llm call eval coverage", () => {
  it("has one eval case for every production LLM call", () => {
    expect(LLM_EVAL_CASES.map((testCase) => testCase.id).sort()).toEqual(
      llmCallCatalog.map((manifest) => manifest.id).sort(),
    );
  });

  it("covers every top-level flow with component eval cases", () => {
    const flowResults = evaluateFlowCoverage();
    expect(flowResults.map((flow) => flow.id)).toEqual([
      "evidence-ingestion.flow",
      "search.flow",
      "match.requirement-flow",
      "match.application-inspection-flow",
      "application-preparation.flow",
    ]);
    expect(flowResults.every((flow) => flow.passed)).toBe(true);
  });

  it("passes the fast schema and semantic contract eval", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "llm-calls-eval-"));
    const result = await runLlmCallEval({
      cwd: process.cwd(),
      outputRoot,
    });
    expect(result.summary.failed).toBe(0);
    expect(result.summary.flowFailed).toBe(0);
  });
});
