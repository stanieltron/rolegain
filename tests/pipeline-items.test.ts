import { describe, expect, it } from "vitest";
import type { SearchPipelineItem } from "../src/contracts/job-search.js";
import {
  applicationOutcomeState,
  isApplicationAttempt,
  pipelineDisplayStage,
  settlePipelineItemForDisplay,
  sortApplicationAttempts,
  sortPipelineRows,
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

  it("places failed application attempts after ready and active attempts", () => {
    const failed = item({
      id: "failed",
      jobNumber: 3,
      application: "failed",
      applicationVerification: "failed",
    });
    const active = item({
      id: "active",
      jobNumber: 2,
      application: "running",
    });
    const ready = item({
      id: "ready",
      jobNumber: 1,
      application: "passed",
      applicationVerification: "passed",
    });
    expect(
      sortApplicationAttempts([failed, active, ready]).map(
        (candidate) => candidate.id,
      ),
    ).toEqual(["ready", "active", "failed"]);
  });

  it("shows each job only in the furthest pipeline stage it reached", () => {
    expect(
      pipelineDisplayStage(
        item({ validation: "failed", match: "waiting", application: "waiting" }),
      ),
    ).toBe("validation");
    expect(pipelineDisplayStage(item({ application: "bench" }))).toBe("match");
    expect(
      pipelineDisplayStage(
        item({ application: "failed", applicationVerification: "failed" }),
      ),
    ).toBe("application");
  });

  it("sorts by current run, then success, then ascending job number", () => {
    const rows = [
      item({ id: "old-success", jobNumber: 1, match: "passed" }),
      item({ id: "current-failed", jobNumber: 4, match: "failed" }),
      item({ id: "current-success-3", jobNumber: 3, match: "passed" }),
      item({ id: "current-success-2", jobNumber: 2, match: "passed" }),
    ];
    expect(
      sortPipelineRows(rows, new Set(["current-failed", "current-success-3", "current-success-2"]), "match")
        .map((candidate) => candidate.id),
    ).toEqual([
      "current-success-2",
      "current-success-3",
      "current-failed",
      "old-success",
    ]);
  });
});
