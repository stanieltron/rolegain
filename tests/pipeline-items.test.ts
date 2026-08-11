import { describe, expect, it } from "vitest";
import type { SearchPipelineItem } from "../src/contracts/job-search.js";
import {
  applicationOutcomeState,
  coalescePipelineItems,
  deriveCurrentRunItemIds,
  isApplicationAttempt,
  isLowMatchPipelineItem,
  isManualReviewPipelineItem,
  pipelineDisplayStage,
  pipelineItemVisible,
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
  it("collapses legacy and canonical Greenhouse records onto the completed job", () => {
    const legacy = item({
      id: "legacy-alpha",
      jobNumber: 8,
      company: "Defuse Labs",
      title: "Alpha Researcher",
      sourceUrl: "https://boards.greenhouse.io/defuselabs/jobs/4942035101",
      match: "waiting",
      application: "waiting",
    });
    const canonical = item({
      id: "canonical-alpha",
      jobNumber: 38,
      company: "Defuse Labs",
      title: "Alpha Researcher",
      sourceUrl:
        "https://job-boards.greenhouse.io/defuselabs/jobs/4942035101",
      application: "passed",
      applicationVerification: "passed",
      applicationReady: true,
    });

    expect(coalescePipelineItems([canonical, legacy])).toEqual([canonical]);
  });

  it("keeps distinct same-title Greenhouse vacancies separate", () => {
    const first = item({
      id: "alpha-one",
      company: "Defuse Labs",
      title: "Alpha Researcher",
      sourceUrl: "https://boards.greenhouse.io/defuselabs/jobs/4942035101",
    });
    const second = item({
      id: "alpha-two",
      company: "Defuse Labs",
      title: "Alpha Researcher",
      sourceUrl:
        "https://job-boards.greenhouse.io/defuselabs/jobs/4942035102",
    });

    expect(coalescePipelineItems([first, second])).toEqual([first, second]);
  });

  it("does not move a matched job back to discovery when a later run rediscovers it", () => {
    const matched = item({
      id: "stable-job",
      jobNumber: 31,
      fit: 77,
      applicationRouteStatus: "manual_review",
    });
    const rediscoveredFailure = item({
      id: "stable-job",
      jobNumber: 31,
      validation: "failed",
      match: "waiting",
      application: "waiting",
      applicationVerification: "waiting",
      reason: "Application page is blocked by bot verification",
    });

    expect(coalescePipelineItems([matched, rediscoveredFailure])).toEqual([
      matched,
    ]);
  });

  it("shows an active application retry instead of its older terminal failure", () => {
    const failed = item({
      id: "retried-job",
      application: "failed",
      applicationVerification: "failed",
    });
    const retrying = item({
      id: "retried-job",
      application: "passed",
      applicationVerification: "running",
    });

    expect(coalescePipelineItems([failed, retrying])).toEqual([retrying]);
  });

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
    expect(
      settlePipelineItemForDisplay(
        item({ application: "waiting", match: "passed" }),
        true,
      ).application,
    ).toBe("bench");
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

  it("hides terminal failures and benches outside developer mode", () => {
    const failedApplication = item({
      application: "failed",
      applicationVerification: "failed",
    });
    expect(
      pipelineItemVisible(failedApplication, "application", false, 70),
    ).toBe(false);
    expect(
      pipelineItemVisible(failedApplication, "application", true, 70),
    ).toBe(true);
    expect(pipelineItemVisible(item(), "match", false, 70)).toBe(false);
  });

  it("always shows queued and running work outside developer mode", () => {
    expect(
      pipelineItemVisible(
        item({ validation: "running", match: "waiting", application: "waiting" }),
        "validation",
        false,
        70,
      ),
    ).toBe(true);
    expect(
      pipelineItemVisible(
        item({ match: "running", application: "waiting" }),
        "match",
        false,
        70,
      ),
    ).toBe(true);
    expect(
      pipelineItemVisible(
        item({ application: "passed", applicationVerification: "running" }),
        "application",
        false,
        70,
      ),
    ).toBe(true);
  });

  it("keeps manual-review and below-threshold matches actionable", () => {
    const manualReview = item({
      validation: "failed",
      match: "waiting",
      application: "waiting",
      validationDisposition: "manual_review",
    });
    const lowMatch = item({ fit: 64 });
    const manualApplicationRoute = item({
      match: "passed",
      applicationRouteStatus: "manual_review",
      applicationRouteReason: "Employer form could not be verified",
    });
    expect(isManualReviewPipelineItem(manualReview)).toBe(true);
    expect(
      pipelineItemVisible(manualReview, "validation", false, 70),
    ).toBe(true);
    expect(isLowMatchPipelineItem(lowMatch, 70)).toBe(true);
    expect(pipelineItemVisible(lowMatch, "match", false, 70)).toBe(true);
    expect(isManualReviewPipelineItem(manualApplicationRoute)).toBe(true);
    expect(
      pipelineItemVisible(manualApplicationRoute, "match", false, 70),
    ).toBe(true);
  });

  it("does not expose failed application mapping as a normal-mode manual review", () => {
    const failedMapping = item({
      application: "failed",
      applicationVerification: "failed",
      validationDisposition: "manual_review",
    });
    expect(
      pipelineItemVisible(failedMapping, "application", false, 70),
    ).toBe(false);
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

  it("recovers the latest application batch from legacy cumulative progress", () => {
    const first = item({ id: "first-application" });
    const second = item({ id: "second-application" });
    const oldManualReview = item({ id: "old-manual-review" });

    expect(
      [...deriveCurrentRunItemIds({
        progressItems: [first, second, oldManualReview],
        historyItems: [first, second, oldManualReview],
        baselineApplicationJobIds: [first.id],
        preparedApplicationJobIds: [first.id, second.id],
        terminal: true,
      })],
    ).toEqual([second.id]);
  });

  it("keeps the explicit progress boundary for active and corrected runs", () => {
    const current = item({ id: "current" });
    const previous = item({ id: "previous" });

    expect(
      [...deriveCurrentRunItemIds({
        progressItems: [current],
        historyItems: [current, previous],
        baselineApplicationJobIds: [previous.id],
        preparedApplicationJobIds: [current.id, previous.id],
        terminal: false,
      })],
    ).toEqual([current.id]);
  });
});
