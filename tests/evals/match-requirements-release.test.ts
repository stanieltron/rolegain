import { describe, expect, it } from "vitest";
import {
  evaluateReleaseGates,
  type EvalSummary,
  type SummaryGroup,
} from "../../evals/match-requirements/src/harness/release-gate.js";
import { compareTrialResults, type ComparableTrial } from "../../evals/match-requirements/src/harness/comparison.js";
import {
  pairedBootstrapInterval,
  summarizeCaseReliability,
  wilsonScoreInterval,
} from "../../evals/match-requirements/src/harness/statistics.js";

describe("match-requirements release validity", () => {
  it("passes only a complete, repeated, compatible, human-reviewed scoped run", () => {
    const gate = evaluateReleaseGates(completeSummary());
    expect(gate.eligible).toBe(true);
    expect(gate.models).toHaveLength(1);
    expect(gate.models[0]).toMatchObject({
      status: "pass",
      eligible: true,
      passed: true,
    });
  });

  it("makes a partial corpus ineligible even when its metrics and labels pass", () => {
    const summary = completeSummary();
    summary.dataset.cases = 25;
    summary.dataset.goldRows = 51;
    const gate = evaluateReleaseGates(summary);
    expect(gate.eligible).toBe(false);
    expect(gate.datasetChecks.filter((check) => !check.passed).map((check) => check.name))
      .toEqual(["dataset.cases", "dataset.goldRows"]);
    expect(gate.models[0].status).toBe("ineligible");
  });

  it("reports omitted suites as not evaluated instead of zero-quality results", () => {
    const summary = completeSummary();
    summary.execution.suites = ["match.full-flow"];
    summary.groups = summary.groups.filter((group) => group.suite === "match.full-flow");
    const gate = evaluateReleaseGates(summary);
    const verifierCheck = gate.models[0].checks.find(
      (check) => check.name === "verifier.defectRecall",
    );
    expect(gate.models[0].status).toBe("ineligible");
    expect(verifierCheck).toMatchObject({
      actual: null,
      status: "not_evaluated",
      passed: false,
    });
  });

  it("rejects one-trial and incompatible-runtime release attempts", () => {
    const summary = completeSummary();
    summary.execution.requestedTrials = 1;
    summary.execution.runtimeCompatible = false;
    for (const group of summary.groups) group.minimumTrialsPerCase = 1;
    const gate = evaluateReleaseGates(summary);
    expect(gate.executionChecks.filter((check) => !check.passed).map((check) => check.name))
      .toEqual([
        "execution.runtimeCompatible",
        "execution.requestedTrials",
      ]);
    expect(gate.models[0].status).toBe("ineligible");
  });

  it("distinguishes eligible quality failure from run ineligibility", () => {
    const summary = completeSummary();
    summary.groups.find((group) => group.suite === "match.full-flow")!.passRate = 0.94;
    const gate = evaluateReleaseGates(summary);
    expect(gate.eligible).toBe(true);
    expect(gate.models[0]).toMatchObject({ status: "fail", eligible: true });
  });
});

describe("match-requirements statistical reporting", () => {
  it("computes finite-sample Wilson intervals", () => {
    expect(wilsonScoreInterval(100, 100)).toEqual({
      confidenceLevel: 0.95,
      lower: 0.963,
      upper: 1,
      method: "wilson-score",
    });
    expect(wilsonScoreInterval(0, 0)).toBeNull();
  });

  it("uses deterministic paired task bootstrap intervals", () => {
    expect(pairedBootstrapInterval([-0.1, 0, 0.1])).toEqual(
      pairedBootstrapInterval([-0.1, 0, 0.1]),
    );
  });

  it("reports one-trial stability as unavailable and repeated instability honestly", () => {
    expect(
      summarizeCaseReliability([
        { caseId: "a", passed: true },
        { caseId: "b", passed: false },
      ]),
    ).toMatchObject({
      minimumTrialsPerCase: 1,
      passAllTrialsRate: 0.5,
      unstableCaseRate: null,
    });
    expect(
      summarizeCaseReliability([
        { caseId: "a", passed: true },
        { caseId: "a", passed: false },
        { caseId: "b", passed: true },
        { caseId: "b", passed: true },
      ]),
    ).toMatchObject({
      minimumTrialsPerCase: 2,
      passAllTrialsRate: 0.5,
      passAtLeastOnceRate: 1,
      unstableCaseRate: 0.5,
    });
  });

  it("classifies paired semantic regressions and mismatched case sets", () => {
    const baseline = Array.from({ length: 6 }, (_, index) => trial(`case-${index}`, true));
    const regressed = baseline.map((item) => ({ ...item, passed: false }));
    const comparison = compareTrialResults(baseline, regressed)[0];
    expect(comparison).toMatchObject({
      eligible: true,
      decision: "regression",
      pairedCases: 6,
    });
    expect(comparison.metrics.passRate).toMatchObject({
      delta: -1,
      decision: "regression",
    });

    const mismatched = compareTrialResults(baseline, regressed.slice(1))[0];
    expect(mismatched).toMatchObject({
      eligible: false,
      caseSetMatches: false,
      decision: "ineligible",
    });
  });

  it("compares different model configurations on the same paired cases", () => {
    const baseline = Array.from({ length: 6 }, (_, index) =>
      trial(`case-${index}`, true),
    );
    const candidate = baseline.map((item) => ({
      ...item,
      configurationId: "primary-model-v1",
      model: "candidate-model",
    }));
    const comparison = compareTrialResults(baseline, candidate)[0];
    expect(comparison).toMatchObject({
      eligible: true,
      decision: "non_inferior",
      baselineModel: "model",
      candidateModel: "candidate-model",
      pairedCases: 6,
    });
  });
});

function completeSummary(): EvalSummary {
  return {
    execution: {
      requestedTrials: 3,
      suites: [
        "match.requirements.component",
        "match.tier2.component",
        "match.verification.component",
        "match.repair.component",
        "match.full-flow",
      ],
      runtimeVersion: "supported",
      runtimeCompatible: true,
    },
    dataset: {
      cases: 52,
      goldRows: 108,
      humanReviewedRate: 1,
      suiteCases: {
        "match.requirements.component": 52,
        "match.tier2.component": 52,
        "match.verification.component": 52,
        "match.repair.component": 17,
        "match.full-flow": 52,
      },
    },
    groups: [
      group("match.requirements.component", 52),
      group("match.tier2.component", 52),
      group("match.verification.component", 52),
      group("match.repair.component", 17),
      group("match.full-flow", 52),
    ],
  };
}

function group(suite: string, caseCount: number): SummaryGroup {
  return {
    model: "model",
    suite,
    trials: caseCount * 3,
    caseCount,
    minimumTrialsPerCase: 3,
    passRate: 1,
    passRateCi95: {
      confidenceLevel: 0.95,
      lower: 0.95,
      upper: 1,
      method: "wilson-score",
    },
    passAllTrialsRate: 1,
    passAllTrialsRateCi95: {
      confidenceLevel: 0.95,
      lower: 0.95,
      upper: 1,
      method: "wilson-score",
    },
    unstableCaseRate: 0,
    pipelineAcceptanceRate: 1,
    requirementRecall: 1,
    requirementPrecision: 1,
    rowAccuracy: 1,
    citationPrecision: 1,
    criticalSafetyRate: 1,
    componentRequirementRecall: 1,
    componentRequirementPrecision: 1,
    componentRowAccuracy: 1,
    verifierDefectRecall: 1,
    verifierCleanSpecificity: 1,
    verifierTargetedFindingRate: 1,
  };
}

function trial(caseId: string, passed: boolean): ComparableTrial {
  return {
    model: "model",
    suite: "match.full-flow",
    caseId,
    passed,
    pipelineAccepted: true,
    wallMs: 100,
    totalTokens: 100,
    grade: {
      requirementRecall: 1,
      requirementPrecision: 1,
      rowAccuracy: 1,
      citationPrecision: 1,
      criticalFailures: [],
    },
  };
}
