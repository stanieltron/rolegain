import { describe, expect, it } from "vitest";
import { evidenceEvalCorpus } from "../../../src/01-evidence-ingestion/evals/corpus.js";
import { detectPromptInjectionSignals } from "../../../src/01-evidence-ingestion/02-chunk-reader/prompt-injection/index.js";
import { chunkSourceWithLocators } from "../../../src/01-evidence-ingestion/02-chunk-reader/index.js";

describe("evidence model-behavior eval corpus", () => {
  it("keeps every expected quotation inside its immutable source", () => {
    expect(evidenceEvalCorpus.length).toBeGreaterThanOrEqual(6);
    for (const testCase of evidenceEvalCorpus)
      for (const quote of testCase.expectedQuotes)
        expect(testCase.cvText, `${testCase.id}: ${quote}`).toContain(quote);
  });

  it("covers prompt injection and long multi-chunk behavior explicitly", () => {
    const injection = evidenceEvalCorpus.find(
      (testCase) => testCase.id === "instruction-shaped-cv",
    )!;
    expect(
      detectPromptInjectionSignals(injection.cvText).map((signal) => signal.id),
    ).toEqual(expect.arrayContaining(injection.expectedInjectionSignals || []));

    const boundary = evidenceEvalCorpus.find(
      (testCase) => testCase.id === "chunk-boundary-cv",
    )!;
    const chunks = chunkSourceWithLocators(boundary.cvText);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((chunk) => chunk.content.includes(boundary.expectedQuotes[0]))).toBe(true);
  });
});
