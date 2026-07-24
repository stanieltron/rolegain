import type { ConfidenceInterval } from "./statistics.js";
import { MATCH_REQUIREMENTS_RELEASE_THRESHOLDS as thresholds } from "../config/thresholds.js";

type CheckValue = number | boolean | null;
type CheckStatus = "passed" | "failed" | "not_evaluated";
type ReleaseStatus = "pass" | "fail" | "ineligible";

export interface SummaryGroup {
  model: string;
  suite: string;
  trials: number;
  caseCount: number;
  minimumTrialsPerCase: number;
  passRate: number;
  passRateCi95: ConfidenceInterval | null;
  passAllTrialsRate: number | null;
  passAllTrialsRateCi95: ConfidenceInterval | null;
  unstableCaseRate: number | null;
  pipelineAcceptanceRate: number;
  requirementRecall: number;
  requirementPrecision: number;
  rowAccuracy: number;
  citationPrecision: number;
  criticalSafetyRate: number;
  componentRequirementRecall: number;
  componentRequirementPrecision: number;
  componentRowAccuracy: number;
  verifierDefectRecall: number;
  verifierCleanSpecificity: number;
  verifierTargetedFindingRate: number;
}

export interface EvalSummary {
  execution: {
    requestedTrials: number;
    suites: string[];
    runtimeVersion: string;
    runtimeCompatible: boolean;
  };
  dataset: {
    cases: number;
    goldRows: number;
    humanReviewedRate: number;
    suiteCases: Record<string, number>;
  };
  groups: SummaryGroup[];
}

export interface ReleaseGateCheck {
  name: string;
  actual: CheckValue;
  threshold: number | boolean;
  status: CheckStatus;
  passed: boolean;
  reason?: string;
}

export function evaluateReleaseGates(summary: EvalSummary) {
  const requiredSuites = [...thresholds.execution.requiredSuites];
  const datasetChecks = [
    minimum("dataset.cases", summary.dataset.cases, thresholds.dataset.minimumCases),
    minimum(
      "dataset.goldRows",
      summary.dataset.goldRows,
      thresholds.dataset.minimumGoldRows,
    ),
    minimum(
      "dataset.humanReviewedRate",
      summary.dataset.humanReviewedRate,
      thresholds.dataset.humanReviewedRate,
    ),
  ];
  const executionChecks = [
    equal(
      "execution.runtimeCompatible",
      summary.execution.runtimeCompatible,
      thresholds.execution.runtimeCompatible,
      `Runtime ${summary.execution.runtimeVersion || "unknown"} is not the supported eval runtime`,
    ),
    minimum(
      "execution.requestedTrials",
      summary.execution.requestedTrials,
      thresholds.execution.minimumTrialsPerCase,
    ),
    ...requiredSuites.map((suite) =>
      equal(
        `execution.suite.${suite}`,
        summary.execution.suites.includes(suite),
        true,
        `Required suite ${suite} was not selected`,
      ),
    ),
  ];
  const globallyEligible = allPassed([...datasetChecks, ...executionChecks]);
  const models = [...new Set(summary.groups.map((group) => group.model))];
  const modelResults = models.map((model) => {
      const groups = Object.fromEntries(
        requiredSuites.map((suite) => [
          suite,
          summary.groups.find((item) => item.model === model && item.suite === suite),
        ]),
      ) as Record<string, SummaryGroup | undefined>;
      const completenessChecks = requiredSuites.flatMap((suite) => {
        const current = groups[suite];
        const expectedCases = summary.dataset.suiteCases[suite] || 0;
        if (!current) {
          return [
            notEvaluated(
              `model.${suite}.present`,
              true,
              `No ${suite} results were produced for ${model}`,
            ),
            notEvaluated(
              `model.${suite}.caseCount`,
              expectedCases,
              `Cannot check case coverage without ${suite} results`,
            ),
            notEvaluated(
              `model.${suite}.minimumTrialsPerCase`,
              thresholds.execution.minimumTrialsPerCase,
              `Cannot check trial coverage without ${suite} results`,
            ),
          ];
        }
        return [
          equal(`model.${suite}.present`, true, true),
          minimum(`model.${suite}.caseCount`, current.caseCount, expectedCases),
          minimum(
            `model.${suite}.minimumTrialsPerCase`,
            current.minimumTrialsPerCase,
            thresholds.execution.minimumTrialsPerCase,
          ),
        ];
      });
      const firstPass = groups["match.requirements.component"];
      const tier2 = groups["match.tier2.component"];
      const verifier = groups["match.verification.component"];
      const repair = groups["match.repair.component"];
      const fullFlow = groups["match.full-flow"];
      const qualityChecks = [
        metricMinimum(
          "component.requirementRecall",
          firstPass,
          "requirementRecall",
          thresholds.component.requirementRecall,
        ),
        metricMinimum(
          "component.requirementPrecision",
          firstPass,
          "requirementPrecision",
          thresholds.component.requirementPrecision,
        ),
        metricMinimum(
          "component.rowAccuracy",
          firstPass,
          "rowAccuracy",
          thresholds.component.rowAccuracy,
        ),
        metricMinimum(
          "tier2.passRate",
          tier2,
          "passRate",
          thresholds.tier2.passRate,
        ),
        metricMinimum(
          "tier2.pipelineAcceptanceRate",
          tier2,
          "pipelineAcceptanceRate",
          thresholds.tier2.pipelineAcceptanceRate,
        ),
        metricMinimum(
          "tier2.rowAccuracy",
          tier2,
          "rowAccuracy",
          thresholds.tier2.rowAccuracy,
        ),
        metricMinimum(
          "tier2.citationPrecision",
          tier2,
          "citationPrecision",
          thresholds.tier2.citationPrecision,
        ),
        metricMinimum(
          "endToEnd.passRate",
          fullFlow,
          "passRate",
          thresholds.endToEnd.passRate,
        ),
        minimumIntervalBound(
          "endToEnd.passAllTrialsRate.lowerBound95",
          fullFlow?.passAllTrialsRateCi95,
          thresholds.reliability.minimumPassAllTrialsLowerBound95,
        ),
        metricMinimum(
          "endToEnd.passAllTrialsRate",
          fullFlow,
          "passAllTrialsRate",
          thresholds.reliability.minimumPassAllTrialsRate,
        ),
        metricMaximum(
          "endToEnd.unstableCaseRate",
          fullFlow,
          "unstableCaseRate",
          thresholds.reliability.maximumUnstableCaseRate,
        ),
        metricMinimum(
          "endToEnd.pipelineAcceptanceRate",
          fullFlow,
          "pipelineAcceptanceRate",
          thresholds.endToEnd.pipelineAcceptanceRate,
        ),
        metricMinimum(
          "endToEnd.requirementRecall",
          fullFlow,
          "requirementRecall",
          thresholds.endToEnd.requirementRecall,
        ),
        metricMinimum(
          "endToEnd.requirementPrecision",
          fullFlow,
          "requirementPrecision",
          thresholds.endToEnd.requirementPrecision,
        ),
        metricMinimum(
          "endToEnd.rowAccuracy",
          fullFlow,
          "rowAccuracy",
          thresholds.endToEnd.rowAccuracy,
        ),
        metricMinimum(
          "endToEnd.citationPrecision",
          fullFlow,
          "citationPrecision",
          thresholds.endToEnd.citationPrecision,
        ),
        metricMinimum(
          "endToEnd.criticalSafetyRate",
          fullFlow,
          "criticalSafetyRate",
          thresholds.endToEnd.criticalSafetyRate,
        ),
        metricMinimum(
          "verifier.defectRecall",
          verifier,
          "verifierDefectRecall",
          thresholds.verifier.defectRecall,
        ),
        metricMinimum(
          "verifier.cleanSpecificity",
          verifier,
          "verifierCleanSpecificity",
          thresholds.verifier.cleanSpecificity,
        ),
        metricMinimum(
          "verifier.targetedFindingRate",
          verifier,
          "verifierTargetedFindingRate",
          thresholds.verifier.targetedFindingRate,
        ),
        metricMinimum(
          "repair.passRate",
          repair,
          "passRate",
          thresholds.repair.passRate,
        ),
        metricMinimum(
          "repair.pipelineAcceptanceRate",
          repair,
          "pipelineAcceptanceRate",
          thresholds.repair.pipelineAcceptanceRate,
        ),
        metricMinimum(
          "repair.rowAccuracy",
          repair,
          "rowAccuracy",
          thresholds.repair.rowAccuracy,
        ),
        metricMinimum(
          "repair.citationPrecision",
          repair,
          "citationPrecision",
          thresholds.repair.citationPrecision,
        ),
      ];
      const eligible = globallyEligible && allPassed(completenessChecks);
      const passed = eligible && allPassed(qualityChecks);
      const status: ReleaseStatus = !eligible ? "ineligible" : passed ? "pass" : "fail";
      return {
        model,
        status,
        eligible,
        passed,
        completenessChecks,
        qualityChecks,
        checks: [...completenessChecks, ...qualityChecks],
      };
    });
  const eligible =
    globallyEligible && modelResults.length > 0 && modelResults.every((item) => item.eligible);
  const passed = eligible && modelResults.every((item) => item.passed);
  return {
    thresholds,
    status: !eligible ? ("ineligible" as const) : passed ? ("pass" as const) : ("fail" as const),
    eligible,
    passed,
    datasetChecks,
    executionChecks,
    models: modelResults,
  };
}

function metricMinimum<K extends keyof SummaryGroup>(
  name: string,
  group: SummaryGroup | undefined,
  key: K,
  threshold: number,
) {
  const actual = group?.[key];
  return typeof actual === "number"
    ? minimum(name, actual, threshold)
    : notEvaluated(name, threshold, `Metric ${name} was not evaluated`);
}

function metricMaximum<K extends keyof SummaryGroup>(
  name: string,
  group: SummaryGroup | undefined,
  key: K,
  threshold: number,
) {
  const actual = group?.[key];
  return typeof actual === "number"
    ? maximum(name, actual, threshold)
    : notEvaluated(name, threshold, `Metric ${name} requires repeated trials`);
}

function minimumIntervalBound(
  name: string,
  interval: ConfidenceInterval | null | undefined,
  threshold: number,
) {
  return interval
    ? minimum(name, interval.lower, threshold)
    : notEvaluated(name, threshold, `Confidence interval ${name} was not evaluated`);
}

function minimum(name: string, actual: number, threshold: number): ReleaseGateCheck {
  return check(name, actual, threshold, actual >= threshold);
}

function maximum(name: string, actual: number, threshold: number): ReleaseGateCheck {
  return check(name, actual, threshold, actual <= threshold);
}

function equal(
  name: string,
  actual: boolean,
  threshold: boolean,
  reason?: string,
): ReleaseGateCheck {
  return check(name, actual, threshold, actual === threshold, reason);
}

function check(
  name: string,
  actual: number | boolean,
  threshold: number | boolean,
  passed: boolean,
  reason?: string,
): ReleaseGateCheck {
  return {
    name,
    actual,
    threshold,
    status: passed ? "passed" : "failed",
    passed,
    ...(passed || !reason ? {} : { reason }),
  };
}

function notEvaluated(
  name: string,
  threshold: number | boolean,
  reason: string,
): ReleaseGateCheck {
  return {
    name,
    actual: null,
    threshold,
    status: "not_evaluated",
    passed: false,
    reason,
  };
}

function allPassed(checks: ReleaseGateCheck[]) {
  return checks.every((item) => item.status === "passed");
}
