import type { JobOpportunity } from "../../../../../contracts/job-search.js";
import { vacanciesForMatching } from "../01-requirement-matching/input.js";
import type { AgentRequirementAssessment } from "../01-requirement-matching/output.js";
import type { AssessmentVerificationOutput } from "../03-match-verification/output.js";
import type { ResultGatewayDefect } from "../../../../../codex-runtime/result-gateway.js";

export function buildInput(input: {
  sourceLedger: unknown;
  opportunities: JobOpportunity[];
  assessments: AgentRequirementAssessment[];
  failures: AssessmentVerificationOutput[];
}) {
  const failedIds = new Set(input.failures.map((item) => item.jobId));
  return `Repair the failed assessment using only the verifier findings. Return its jobId once at the top level and one complete requirements array.

Final-output invariants:
- The same trimmed, case-insensitive requirement text must occur exactly once.
- Different statuses, explanations, normalized capabilities, or evidence do not make duplicate requirement text valid.
- If a compound employer sentence needs separate rows, rewrite each row as one distinct faithful atomic clause. Never copy the complete compound sentence into multiple rows.
- Otherwise consolidate the compound sentence into one row with one truthful overall classification.
- A responsibilitiesText or qualificationText field marked full_description_fallback is an intentional conservative fallback to the complete employer vacancy. Repair the affected rows against that text; do not reject the entire vacancy because a standalone section was unavailable.

Candidate source ledger:
${JSON.stringify(input.sourceLedger, null, 2)}

Vacancies:
${JSON.stringify(
  vacanciesForMatching(input.opportunities.filter((job) => failedIds.has(job.id))),
  null,
  2,
)}

Current assessments:
${JSON.stringify(
  input.assessments.filter((item) => failedIds.has(item.jobId)),
  null,
  2,
)}

Verifier findings:
${JSON.stringify(input.failures, null, 2)}`;
}

export function buildRecoveryInput(defects: ResultGatewayDefect[]) {
  return `Your previous repair output failed deterministic validation.

Defects:
${JSON.stringify(defects, null, 2)}

Return the complete replacement assessment again, not a patch.
- Correct every listed defect and preserve valid unrelated rows.
- Each trimmed, case-insensitive requirement text may appear only once.
- Consolidate duplicate rows, or split a compound sentence into distinct faithful atomic-clause text.
- Never repeat the complete compound sentence in multiple rows, even when their statuses or explanations differ.
- Before returning, compare every requirement string against every other requirement string.

Return only schema-conforming JSON.`;
}

export const inputDescription =
  "Failed job assessments, their original vacancies and citation ledger, and verifier findings/instructions only.";
