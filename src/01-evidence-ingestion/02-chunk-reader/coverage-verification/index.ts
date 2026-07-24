import type {
  ChunkCoverageVerification,
  CoverageFinding,
} from "../llm-calls/02-coverage-verification/output.js";

export interface CoverageDecision {
  passed: boolean;
  missingEvidence: CoverageFinding[];
  unsupportedExtractions: string[];
  feedback: string[];
}

/** Accept verifier omissions only when their purported exact quote exists. */
export function decideChunkCoverage(
  chunk: string,
  result: ChunkCoverageVerification,
): CoverageDecision {
  const missingEvidence = (result.missingEvidence || []).filter(
    (finding) =>
      finding.severity !== "warning" &&
      finding.quote.trim() &&
      containsQuote(chunk, finding.quote),
  );
  const unsupportedExtractions = (result.unsupportedExtractions || [])
    .map((item) => item.trim())
    .filter(Boolean);
  const feedback = [
    ...missingEvidence.map(
      (finding) =>
        `${finding.operation || "add"} ${finding.target || finding.category}${finding.field ? `.${finding.field}` : ""} supported by: ${JSON.stringify(finding.quote)} (${finding.reason})`,
    ),
    ...unsupportedExtractions.map(
      (item) => `Remove or correct unsupported extraction: ${item}`,
    ),
  ];
  return {
    // The structured, quote-validated findings are authoritative. A model may
    // set complete=false for a warning; that must not create an unrepairable
    // failure with no actionable feedback.
    passed: missingEvidence.length === 0 && unsupportedExtractions.length === 0,
    missingEvidence,
    unsupportedExtractions,
    feedback,
  };
}

function containsQuote(content: string, quote: string) {
  const normalizedContent = content.replace(/-\s+/g, "-").replace(/\s+/g, " ").trim();
  const normalizedQuote = quote.replace(/-\s+/g, "-").replace(/\s+/g, " ").trim();
  return normalizedContent.includes(normalizedQuote);
}
