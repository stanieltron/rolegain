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
