import type { evaluateReleaseGates } from "./release-gate.js";
import type { MatchEvalTrialResult } from "./runner.js";
import type { MatchEvalSummary } from "./summary.js";

export function renderMatchEvalReport(
  summary: MatchEvalSummary,
  results: MatchEvalTrialResult[],
  releaseGate: ReturnType<typeof evaluateReleaseGates>,
) {
  const lines = [
    "# Match-requirements eval report",
    "",
    `Corpus: ${summary.corpusVersion}  `,
    `Completed: ${summary.completedAt}  `,
    `Trials: ${summary.totalTrials}`,
    `Cases: ${summary.dataset.cases}; gold rows: ${summary.dataset.goldRows}; human-reviewed: ${pct(summary.dataset.humanReviewedRate)}`,
    `Requested trials per case: ${summary.execution.requestedTrials}; matching: ${summary.execution.pipelineVersion}; runtime: ${summary.execution.runtimeVersion} (${summary.execution.runtimeCompatible ? "compatible" : "incompatible"})`,
    "",
    "| Model | Suite | Pass (95% CI) | Pass all trials | Accepted | Mean wall | Mean tokens | Calls | Recall | Precision | Row accuracy | Citation precision |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const group of summary.groups) {
    lines.push(
      `| ${group.model} | ${group.suite} | ${pct(group.passRate)} (${group.passed}/${group.trials}; ${formatInterval(group.passRateCi95)}) | ${pct(group.passAllTrialsRate)} (${formatInterval(group.passAllTrialsRateCi95)}) | ${pct(group.pipelineAcceptanceRate)} | ${group.meanWallMs} ms | ${group.meanTotalTokens} | ${group.meanCalls} | ${pct(group.requirementRecall)} | ${pct(group.requirementPrecision)} | ${pct(group.rowAccuracy)} | ${pct(group.citationPrecision)} |`,
    );
  }
  lines.push(
    "",
    "## Layer diagnostics",
    "",
    "| Model | Suite | Component recall | Component row accuracy | Verifier defect recall | Clean specificity | Targeted findings | Hard failures | Unstable cases |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ...summary.groups.map(
      (group) =>
        `| ${group.model} | ${group.suite} | ${pct(group.componentRequirementRecall)} | ${pct(group.componentRowAccuracy)} | ${pct(group.verifierDefectRecall)} | ${pct(group.verifierCleanSpecificity)} | ${pct(group.verifierTargetedFindingRate)} | ${pct(group.hardFailureRate)} | ${pct(group.unstableCaseRate)} |`,
    ),
    "",
    "## Release gates",
    "",
    `Overall status: **${releaseGate.status.toUpperCase()}**`,
    "",
    ...[...releaseGate.datasetChecks, ...releaseGate.executionChecks]
      .filter((check) => !check.passed)
      .map((check) => `- ${check.name}: ${check.status} (actual ${formatValue(check.actual)}; required ${formatValue(check.threshold)})${check.reason ? ` - ${check.reason}` : ""}`),
    "",
    ...releaseGate.models.map(
      (model) =>
        `- ${model.model}: **${model.status.toUpperCase()}** (${model.checks.filter((check) => check.passed).length}/${model.checks.length} checks passed)`,
    ),
    "",
    ...releaseGate.models.flatMap((model) => [
      `### ${model.model} failed or unevaluated checks`,
      "",
      ...(model.checks.some((check) => !check.passed)
        ? model.checks
            .filter((check) => !check.passed)
            .map(
              (check) =>
                `- ${check.name}: ${check.status} (actual ${formatValue(check.actual)}; required ${formatValue(check.threshold)})${check.reason ? ` - ${check.reason}` : ""}`,
            )
        : ["- None"]),
      "",
    ]),
    "",
    "## Trial details",
    "",
    "| Model | Suite | Case | Result | Accepted | Wall | Tokens | Calls | Repair | Tier 2 |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const item of results) {
    lines.push(
      `| ${item.model} | ${item.suite} | ${item.caseId} #${item.trial} | ${item.passed ? "PASS" : "FAIL"} | ${item.pipelineAccepted ? "yes" : "no"} | ${item.wallMs} ms | ${item.totalTokens} | ${item.calls} | ${item.repairInvoked ? "yes" : "no"} | ${item.tier2Invoked ? "yes" : "no"} |`,
    );
  }
  lines.push(
    "",
    "A failed row is not automatically a model failure: inspect `grade.json` and `calls.json` for label ambiguity, verifier behavior, and exact prompts/outputs.",
    "",
  );
  return lines.join("\n");
}

function pct(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return `${Math.round(value * 1000) / 10}%`;
}

function formatInterval(
  interval: { lower: number; upper: number } | null,
) {
  return interval ? `${pct(interval.lower)}-${pct(interval.upper)}` : "N/A";
}

function formatValue(value: number | boolean | null) {
  return value === null ? "N/A" : String(value);
}
