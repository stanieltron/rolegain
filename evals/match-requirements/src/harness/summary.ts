import {
  summarizeCaseReliability,
  wilsonScoreInterval,
} from "./statistics.js";
import { MATCH_REQUIREMENTS_CORPUS_VERSION, type MatchRequirementsEvalCase } from "../dataset/types.js";
import type { MatchEvalSuite, MatchEvalTrialResult } from "./runner.js";

export function summarizeMatchEvalResults(
  results: MatchEvalTrialResult[],
  cases: MatchRequirementsEvalCase[],
  execution: {
    requestedTrials: number;
    suites: MatchEvalSuite[];
    runtimeVersion: string;
    runtimeCompatible: boolean;
    pipelineVersion: "v1" | "v2";
  },
) {
  const groups = new Map<string, MatchEvalTrialResult[]>();
  for (const result of results) {
    const key = `${result.model}\u0000${result.suite}`;
    groups.set(key, [...(groups.get(key) || []), result]);
  }
  return {
    corpusVersion: MATCH_REQUIREMENTS_CORPUS_VERSION,
    completedAt: new Date().toISOString(),
    totalTrials: results.length,
    execution,
    dataset: {
      cases: cases.length,
      goldRows: sum(cases.map((item) => item.expected.length)),
      humanReviewedRate: mean(
        cases.map((item) => (item.labelStatus === "human_reviewed" ? 1 : 0)),
      ),
      families: countBy(cases.map((item) => item.family)),
      splits: countBy(cases.map((item) => item.split)),
      difficulties: countBy(cases.map((item) => item.difficulty)),
      suiteCases: {
        "match.requirements.component": cases.length,
        "match.tier2.component": cases.length,
        "match.verification.component": cases.filter((item) => item.verifierChallenge).length,
        "match.repair.component": cases.filter((item) => item.repairChallenge).length,
        "match.full-flow": cases.length,
      },
    },
    groups: [...groups.entries()].map(([key, group]) => {
      const [model, suite] = key.split("\u0000");
      const reliability = summarizeCaseReliability(group);
      const passed = group.filter((item) => item.passed).length;
      const accepted = group.filter((item) => item.pipelineAccepted).length;
      const criticalSafe = group.filter(
        (item) => item.grade.criticalFailures.length === 0,
      ).length;
      return {
        model,
        suite,
        trials: group.length,
        caseCount: reliability.caseCount,
        minimumTrialsPerCase: reliability.minimumTrialsPerCase,
        maximumTrialsPerCase: reliability.maximumTrialsPerCase,
        passed,
        passRate: ratio(passed, group.length),
        passRateCi95: wilsonScoreInterval(passed, group.length),
        passAllTrialsRate: reliability.passAllTrialsRate,
        passAllTrialsRateCi95: reliability.passAllTrialsRateCi95,
        passAtLeastOnceRate: reliability.passAtLeastOnceRate,
        pipelineAcceptanceRate: ratio(accepted, group.length),
        pipelineAcceptanceRateCi95: wilsonScoreInterval(accepted, group.length),
        meanWallMs: Math.round(mean(group.map((item) => item.wallMs))),
        p95WallMs: percentile(group.map((item) => item.wallMs), 0.95),
        p50WallMs: percentile(group.map((item) => item.wallMs), 0.5),
        totalInputTokens: sum(group.map((item) => item.inputTokens)),
        totalCachedInputTokens: sum(group.map((item) => item.cachedInputTokens)),
        totalOutputTokens: sum(group.map((item) => item.outputTokens)),
        meanTotalTokens: Math.round(mean(group.map((item) => item.totalTokens))),
        p95TotalTokens: percentile(group.map((item) => item.totalTokens), 0.95),
        meanCalls: round(mean(group.map((item) => item.calls))),
        repairRate: mean(group.map((item) => (item.repairInvoked ? 1 : 0))),
        tier2Rate: mean(group.map((item) => (item.tier2Invoked ? 1 : 0))),
        requirementRecall: mean(group.map((item) => item.grade.requirementRecall)),
        requirementPrecision: mean(
          group.map((item) => item.grade.requirementPrecision),
        ),
        rowAccuracy: mean(group.map((item) => item.grade.rowAccuracy)),
        citationPrecision: mean(
          group.map((item) => item.grade.citationPrecision),
        ),
        criticalSafetyRate: ratio(criticalSafe, group.length),
        criticalSafetyRateCi95: wilsonScoreInterval(criticalSafe, group.length),
        componentRequirementRecall: mean(
          group.flatMap((item) =>
            item.componentGrade ? [item.componentGrade.requirementRecall] : [],
          ),
        ),
        componentRequirementPrecision: mean(
          group.flatMap((item) =>
            item.componentGrade ? [item.componentGrade.requirementPrecision] : [],
          ),
        ),
        componentRowAccuracy: mean(
          group.flatMap((item) =>
            item.componentGrade ? [item.componentGrade.rowAccuracy] : [],
          ),
        ),
        verifierVerdictAccuracy: mean(
          group.flatMap((item) =>
            item.verifierGrade ? [item.verifierGrade.verdictPassed ? 1 : 0] : [],
          ),
        ),
        verifierTargetedFindingRate: mean(
          group.flatMap((item) =>
            item.verifierGrade
              ? [item.verifierGrade.targetedFindingPassed ? 1 : 0]
              : [],
          ),
        ),
        verifierDefectRecall: verifierRate(group, "needs_repair"),
        verifierCleanSpecificity: verifierRate(group, "pass"),
        hardFailureRate: mean(group.map((item) => (item.error ? 1 : 0))),
        unstableCaseRate: reliability.unstableCaseRate,
        failureTaxonomy: countBy(
          group.filter((item) => !item.passed).map((item) => item.errorType || "unknown"),
        ),
      };
    }),
    familyResults: summarizeFamilies(results, cases),
  };
}

export type MatchEvalSummary = ReturnType<typeof summarizeMatchEvalResults>;

function summarizeFamilies(
  results: MatchEvalTrialResult[],
  cases: MatchRequirementsEvalCase[],
) {
  const familyByCase = new Map(cases.map((item) => [item.id, item.family]));
  const groups = new Map<string, MatchEvalTrialResult[]>();
  for (const result of results) {
    const family = familyByCase.get(result.caseId) || "unknown";
    const key = `${result.model}\u0000${result.suite}\u0000${family}`;
    groups.set(key, [...(groups.get(key) || []), result]);
  }
  return [...groups.entries()].map(([key, group]) => {
    const [model, suite, family] = key.split("\u0000");
    return {
      model,
      suite,
      family,
      trials: group.length,
      passRate: mean(group.map((item) => (item.passed ? 1 : 0))),
      rowAccuracy: mean(group.map((item) => item.grade.rowAccuracy)),
      criticalSafetyRate: mean(
        group.map((item) => (item.grade.criticalFailures.length === 0 ? 1 : 0)),
      ),
    };
  });
}

function verifierRate(
  group: MatchEvalTrialResult[],
  expected: "pass" | "needs_repair",
) {
  const relevant = group.filter(
    (item) => item.verifierGrade?.expectedVerdict === expected,
  );
  return mean(relevant.map((item) => (item.verifierGrade?.verdictPassed ? 1 : 0)));
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function countBy(values: string[]) {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}

function mean(values: number[]) {
  return values.length ? round(sum(values) / values.length) : 0;
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(p * sorted.length) - 1];
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
