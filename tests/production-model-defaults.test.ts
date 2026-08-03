import { afterEach, describe, expect, it, vi } from "vitest";
import { productionModel } from "../src/codex-runtime/call-manifest.js";
import { command as chunkAnalysis } from "../src/01-evidence-ingestion/v1/02-chunk-reader/llm-calls/01-chunk-analysis/index.js";
import { command as chunkCoverage } from "../src/01-evidence-ingestion/v1/02-chunk-reader/llm-calls/02-coverage-verification/index.js";
import { command as chunkRepair } from "../src/01-evidence-ingestion/v1/02-chunk-reader/llm-calls/03-chunk-repair/index.js";
import { command as evidenceSynthesis } from "../src/01-evidence-ingestion/03-synthesis/llm-calls/01-evidence-synthesis/index.js";
import { command as webDiscovery } from "../src/02-search/v1/01-discovery/llm-calls/01-web-search/index.js";
import { command as listingExtraction } from "../src/02-search/v1/03-vacancy-validation/llm-calls/01-listing-extraction/index.js";
import { command as vacancyVerification } from "../src/02-search/v1/03-vacancy-validation/llm-calls/02-vacancy-verification/index.js";
import { command as requirementMatching } from "../src/03-match/shared/01-requirement-matching/llm-calls/01-requirement-matching/index.js";
import { command as tier2Matching } from "../src/03-match/shared/01-requirement-matching/llm-calls/02-tier2-matching/index.js";
import { command as matchVerification } from "../src/03-match/shared/01-requirement-matching/llm-calls/03-match-verification/index.js";
import { command as matchRepair } from "../src/03-match/shared/01-requirement-matching/llm-calls/04-match-repair/index.js";

afterEach(() => vi.unstubAllEnvs());

describe("production model defaults", () => {
  it("uses the fastest fully passing real-input replay candidate per tested call", () => {
    expect([
      [chunkAnalysis.defaultModel, chunkAnalysis.effort],
      [chunkCoverage.defaultModel, chunkCoverage.effort],
      [chunkRepair.defaultModel, chunkRepair.effort],
      [evidenceSynthesis.defaultModel, evidenceSynthesis.effort],
      [webDiscovery.defaultModel, webDiscovery.effort],
      [listingExtraction.defaultModel, listingExtraction.effort],
      [vacancyVerification.defaultModel, vacancyVerification.effort],
      [requirementMatching.defaultModel, requirementMatching.effort],
      [tier2Matching.defaultModel, tier2Matching.effort],
      [matchVerification.defaultModel, matchVerification.effort],
      [matchRepair.defaultModel, matchRepair.effort],
    ]).toEqual([
      ["gpt-5.6-luna", "low"],
      ["gpt-5.6-luna", "low"],
      ["gpt-5.6-luna", "low"],
      ["gpt-5.6-terra", "low"],
      ["gpt-5.6-luna", "low"],
      ["gpt-5.6-luna", "low"],
      ["gpt-5.6-luna", "low"],
      ["gpt-5.6-terra", "medium"],
      ["gpt-5.6-terra", "low"],
      ["gpt-5.6-luna", "low"],
      ["gpt-5.5", "low"],
    ]);
  });

  it("keeps an operator environment override above the tested default", () => {
    vi.stubEnv("ROLEGAIN_FAST_MODEL", "operator-model");
    expect(productionModel(chunkAnalysis)).toBe("operator-model");
    expect(productionModel(requirementMatching)).toBe("operator-model");
  });
});
