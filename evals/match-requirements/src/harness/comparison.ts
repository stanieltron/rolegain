import { pairedBootstrapInterval, type ConfidenceInterval } from "./statistics.js";
import { MATCH_REQUIREMENTS_RELEASE_THRESHOLDS as thresholds } from "../config/thresholds.js";

export interface ComparableTrial {
  configurationId?: string;
  model: string;
  suite: string;
  caseId: string;
  passed: boolean;
  pipelineAccepted: boolean;
  wallMs: number;
  totalTokens: number;
  grade: {
    requirementRecall: number;
    requirementPrecision: number;
    rowAccuracy: number;
    citationPrecision: number;
    criticalFailures: string[];
  };
}

interface CaseMetrics {
  trials: number;
  passRate: number;
  pipelineAcceptanceRate: number;
  requirementRecall: number;
  requirementPrecision: number;
  rowAccuracy: number;
  citationPrecision: number;
  criticalSafetyRate: number;
  meanWallMs: number;
  meanTotalTokens: number;
}

export interface PairedMetricComparison {
  baselineMean: number;
  candidateMean: number;
  delta: number;
  deltaCi95: ConfidenceInterval | null;
  nonInferiorityMargin?: number;
  decision?: "non_inferior" | "regression" | "inconclusive";
}

const semanticMetrics = [
  "passRate",
  "pipelineAcceptanceRate",
  "requirementRecall",
  "requirementPrecision",
  "rowAccuracy",
  "citationPrecision",
  "criticalSafetyRate",
] as const;

const resourceMetrics = ["meanWallMs", "meanTotalTokens"] as const;

export function compareTrialResults(
  baseline: ComparableTrial[],
  candidate: ComparableTrial[],
) {
  const keys = [...new Set([...baseline, ...candidate].map((item) => item.suite))].sort();
  return keys.map((key) => {
    const suite = key;
    const baselineTrials = baseline.filter((item) => item.suite === suite);
    const candidateTrials = candidate.filter((item) => item.suite === suite);
    const baselineCases = aggregateCases(
      baselineTrials,
    );
    const candidateCases = aggregateCases(
      candidateTrials,
    );
    const baselineIds = [...baselineCases.keys()].sort();
    const candidateIds = [...candidateCases.keys()].sort();
    const sharedCaseIds = candidateIds.filter((id) => baselineCases.has(id));
    const caseSetMatches = arraysEqual(baselineIds, candidateIds);
    const trialCountsMatch = sharedCaseIds.every(
      (id) => baselineCases.get(id)?.trials === candidateCases.get(id)?.trials,
    );
    const eligible =
      sharedCaseIds.length > 0 && caseSetMatches && trialCountsMatch;
    const metrics = Object.fromEntries(
      [...semanticMetrics, ...resourceMetrics].map((metric) => {
        const pairs = sharedCaseIds.map((caseId) => ({
          baseline: baselineCases.get(caseId)![metric],
          candidate: candidateCases.get(caseId)![metric],
        }));
        const differences = pairs.map((pair) => pair.candidate - pair.baseline);
        const interval = pairedBootstrapInterval(differences);
        const comparison: PairedMetricComparison = {
          baselineMean: round(mean(pairs.map((pair) => pair.baseline))),
          candidateMean: round(mean(pairs.map((pair) => pair.candidate))),
          delta: round(mean(differences)),
          deltaCi95: interval,
        };
        if ((semanticMetrics as readonly string[]).includes(metric)) {
          const margin = thresholds.comparison.semanticNonInferiorityMargin;
          comparison.nonInferiorityMargin = margin;
          comparison.decision = nonInferiorityDecision(interval, margin);
        }
        return [metric, comparison];
      }),
    ) as Record<string, PairedMetricComparison>;
    const decisions = semanticMetrics.map((metric) => metrics[metric].decision);
    return {
      baselineConfigurationId:
        baselineTrials[0]?.configurationId || "unknown",
      candidateConfigurationId:
        candidateTrials[0]?.configurationId || "unknown",
      baselineModel: uniqueValue(baselineTrials.map((item) => item.model)),
      candidateModel: uniqueValue(candidateTrials.map((item) => item.model)),
      suite,
      eligible,
      caseSetMatches,
      trialCountsMatch,
      baselineCases: baselineIds.length,
      candidateCases: candidateIds.length,
      pairedCases: sharedCaseIds.length,
      baselineOnlyCases: baselineIds.filter((id) => !candidateCases.has(id)),
      candidateOnlyCases: candidateIds.filter((id) => !baselineCases.has(id)),
      decision: !eligible
        ? ("ineligible" as const)
        : decisions.includes("regression")
          ? ("regression" as const)
          : decisions.includes("inconclusive")
            ? ("inconclusive" as const)
            : ("non_inferior" as const),
      metrics,
    };
  });
}

function aggregateCases(trials: ComparableTrial[]) {
  const grouped = new Map<string, ComparableTrial[]>();
  for (const trial of trials)
    grouped.set(trial.caseId, [...(grouped.get(trial.caseId) || []), trial]);
  return new Map(
    [...grouped.entries()].map(([caseId, items]) => [
      caseId,
      {
        trials: items.length,
        passRate: mean(items.map((item) => (item.passed ? 1 : 0))),
        pipelineAcceptanceRate: mean(
          items.map((item) => (item.pipelineAccepted ? 1 : 0)),
        ),
        requirementRecall: mean(items.map((item) => item.grade.requirementRecall)),
        requirementPrecision: mean(
          items.map((item) => item.grade.requirementPrecision),
        ),
        rowAccuracy: mean(items.map((item) => item.grade.rowAccuracy)),
        citationPrecision: mean(items.map((item) => item.grade.citationPrecision)),
        criticalSafetyRate: mean(
          items.map((item) => (item.grade.criticalFailures.length === 0 ? 1 : 0)),
        ),
        meanWallMs: mean(items.map((item) => item.wallMs)),
        meanTotalTokens: mean(items.map((item) => item.totalTokens)),
      } satisfies CaseMetrics,
    ]),
  );
}

function nonInferiorityDecision(
  interval: ConfidenceInterval | null,
  margin: number,
) {
  if (!interval) return "inconclusive" as const;
  if (interval.lower >= margin) return "non_inferior" as const;
  if (interval.upper < margin) return "regression" as const;
  return "inconclusive" as const;
}

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueValue(values: string[]) {
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : unique;
}

function mean(values: number[]) {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
