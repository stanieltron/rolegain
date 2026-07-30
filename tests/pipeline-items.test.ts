import { describe, expect, it } from "vitest";
import type { SearchPipelineItem } from "../src/contracts/job-search.js";
import {
  applicationOutcomeState,
  isApplicationAttempt,
  settlePipelineItemForDisplay,
} from "../src/ui/pipeline-items.js";

const item = (
  overrides: Partial<SearchPipelineItem> = {},
): SearchPipelineItem => ({
  id: "job-1",
  company: "Example",
  title: "Engineer",
  sourceUrl: "https://example.test/job",
  validation: "passed",
  match: "passed",
  application: "bench",
  applicationVerification: "waiting",
  ...overrides,
});

describe("pipeline application classification", () => {
  it("moves selected and failed application attempts out of matching", () => {
    const failed = item({
      application: "failed",
      applicationVerification: "failed",
    });
    expect(isApplicationAttempt(failed)).toBe(true);
    expect(applicationOutcomeState(failed)).toBe("failed");
  });

  it("keeps jobs that were only matched on the matching bench", () => {
    const matched = item();
    expect(isApplicationAttempt(matched)).toBe(false);
  });

  it("does not show stale spinners after a workflow has finished", () => {
    const stale = item({ match: "running" });
    expect(settlePipelineItemForDisplay(stale, true).match).toBe("bench");
    expect(settlePipelineItemForDisplay(stale, false).match).toBe("running");
  });
});
