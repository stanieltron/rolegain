export const MAX_REPAIR_ROUNDS = 3;
export const MAX_COVERAGE_ATTEMPTS = MAX_REPAIR_ROUNDS + 1;

export class EvidenceNeedsReviewError extends Error {}

export class EvidenceCoverageNeedsReviewError extends EvidenceNeedsReviewError {
  constructor(
    readonly sourceName: string,
    readonly locator: string,
    readonly feedback: string[],
  ) {
    super(
      `Evidence coverage still failed after ${MAX_REPAIR_ROUNDS} bounded repair rounds for ${sourceName} (${locator}): ${feedback.join("; ")}`,
    );
    this.name = "EvidenceCoverageNeedsReviewError";
  }
}

export class EvidenceAnalysisBudgetError extends EvidenceNeedsReviewError {
  constructor(chunks: number, maximum: number) {
    super(
      `Evidence analysis needs ${chunks} chunks, exceeding the configured maximum of ${maximum}`,
    );
    this.name = "EvidenceAnalysisBudgetError";
  }
}

export function assertEvidenceAnalysisBudget(chunks: number) {
  const configured = Number.parseInt(
    process.env.ROLEGAIN_MAX_EVIDENCE_CHUNKS || "24",
    10,
  );
  const maximum = Number.isFinite(configured)
    ? Math.max(1, Math.min(64, configured))
    : 24;
  if (chunks > maximum) throw new EvidenceAnalysisBudgetError(chunks, maximum);
}
