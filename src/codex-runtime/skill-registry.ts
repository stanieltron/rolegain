export const LLM_CALL_SKILLS = {
  "evidence.chunk-analysis": "rolegain-analyze-cv-chunk",
  "evidence.chunk-coverage": "rolegain-verify-cv-chunk-coverage",
  "evidence.chunk-repair": "rolegain-repair-cv-chunk",
  "evidence.synthesis": "rolegain-synthesize-cv-evidence",
  "search.web-discovery": "rolegain-discover-jobs",
  "search.source-navigation": "rolegain-navigate-vacancy-source",
  "search.listing-extraction": "rolegain-extract-job-listing",
  "search.vacancy-verification": "rolegain-verify-vacancy",
  "match.requirements": "rolegain-match-job-requirements",
  "match.tier2-evidence": "rolegain-match-tier2-evidence",
  "match.verification": "rolegain-verify-job-match",
  "match.repair": "rolegain-repair-job-match",
  "application.navigate": "rolegain-navigate-application",
  "application.field-map": "rolegain-map-application-fields",
  "application.schema-verify": "rolegain-verify-application-schema",
  "application.company-research": "rolegain-research-application-company",
  "application.draft": "rolegain-draft-application",
  "application.verify": "rolegain-verify-application",
  "application.repair": "rolegain-repair-application",
  "application.cover-letter-refine": "rolegain-refine-cover-letter",
  "application.answer-refine": "rolegain-refine-application-answer",
  "application.cv-tailor": "rolegain-tailor-application-cv",
} as const;

export type LlmCallId = keyof typeof LLM_CALL_SKILLS;

export function skillForLlmCall(callId: string | undefined) {
  if (!callId) return undefined;
  return LLM_CALL_SKILLS[callId as LlmCallId];
}
