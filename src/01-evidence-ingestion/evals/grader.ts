import type { CandidateAnalysisResult } from "../types.js";
import type { ProfileFieldEvidence } from "../../contracts/evidence.js";
import type { EvidenceEvalCase } from "./corpus.js";

export interface EvidenceEvalGrade {
  passed: boolean;
  quoteRecall: number;
  missingQuotes: string[];
  forbiddenProfileValuesFound: string[];
  verifiedProfileEvidence: number;
}

/** Outcome grader: model claims do not count unless their source quotes are present. */
export function gradeEvidenceEval(input: {
  testCase: EvidenceEvalCase;
  analysis: CandidateAnalysisResult;
  profileEvidence: ProfileFieldEvidence[];
}): EvidenceEvalGrade {
  const extractedQuotes = input.analysis.sourceInsights.flatMap((source) =>
    (source.claims || []).flatMap((claim) =>
      claim.sourceEvidence.map((evidence) => normalize(evidence.quote)),
    ),
  );
  const missingQuotes = input.testCase.expectedQuotes.filter(
    (quote) => !extractedQuotes.includes(normalize(quote)),
  );
  const profileText = JSON.stringify(input.analysis.profile).toLowerCase();
  const forbiddenProfileValuesFound = input.testCase.forbiddenProfileValues.filter(
    (value) => profileText.includes(value.toLowerCase()),
  );
  const quoteRecall = input.testCase.expectedQuotes.length
    ? (input.testCase.expectedQuotes.length - missingQuotes.length) /
      input.testCase.expectedQuotes.length
    : 1;
  return {
    passed: quoteRecall === 1 && forbiddenProfileValuesFound.length === 0,
    quoteRecall,
    missingQuotes,
    forbiddenProfileValuesFound,
    verifiedProfileEvidence: input.profileEvidence.length,
  };
}

function normalize(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
