import type { JobOpportunity } from "../../../../contracts/job-search.js";
import { vacanciesForMatching } from "../01-requirement-matching/input.js";

export function buildInput(input: {
  sourceLedger: unknown;
  opportunities: JobOpportunity[];
  assessments: unknown;
  deterministicFindings: unknown;
}) {
  return `Independently verify the supplied assessment.

Candidate source ledger:
${JSON.stringify(input.sourceLedger, null, 2)}

Original vacancies:
${JSON.stringify(vacanciesForMatching(input.opportunities), null, 2)}

Generated assessments:
${JSON.stringify(input.assessments, null, 2)}

Deterministic pre-check findings (these must be addressed):
${JSON.stringify(input.deterministicFindings, null, 2)}

Checks:
- Return one top-level verification for the supplied jobId.
- Ensure every core responsibility and explicit candidate qualification was extracted and categorized according to employer wording.
- Responsibility rows must be grounded in responsibilitiesText; mandatory/preferred/constraint rows must be grounded in qualificationText. When the corresponding source marker is full_description_fallback, that field intentionally contains the complete vacancy because the employer page did not expose a clean section. Do not reject merely because a standalone section was unavailable.
- matched requires direct evidence; partial requires genuine adjacent or narrower evidence; missing must have no evidence.
- Every matched or partial row needs a valid sourceId and faithful excerpt.
- Concrete architecture and implementation details may establish complexity. Repository size, technology count, and complexity alone do not establish scalability or production scale; those require explicit scale mechanisms, load, throughput, performance work, or operational evidence. Treat scale-oriented design without evidence that it operated at scale as partial at most.
- Do not reject merely because the candidate has honest missing qualifications.
- Return inflationFlags, feasibilityFlags, statusConfidence, decision, and a concise rationale. A review may maintain or reduce support; it must not increase a match without newly supplied persisted evidence.`;
}

export const inputDescription =
  "Original validated vacancies, generated requirement matrices, canonical citation ledger, and deterministic pre-check findings.";
