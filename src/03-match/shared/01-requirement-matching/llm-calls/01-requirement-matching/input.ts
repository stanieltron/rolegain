import type { JobOpportunity } from "../../../../../contracts/job-search.js";
import {
  extractQualificationSection,
  extractResponsibilitiesSection,
} from "../../../../../search-match-shared/opportunity.js";

export function vacanciesForMatching(opportunities: JobOpportunity[]) {
  return opportunities.map((opportunity) => {
    const description = (opportunity.description || opportunity.summary).slice(
      0,
      30_000,
    );
    const responsibilities = extractResponsibilitiesSection(description);
    const qualifications = extractQualificationSection(description);
    return {
      jobId: opportunity.id,
      company: opportunity.company,
      title: opportunity.title,
      description,
      responsibilitiesText: responsibilities || description,
      qualificationText: qualifications || description,
      responsibilitiesSource:
        responsibilities ? "explicit_section" : "full_description_fallback",
      qualificationSource:
        qualifications ? "explicit_section" : "full_description_fallback",
    };
  });
}

export function buildInput(input: {
  assessmentEvidence: unknown;
  opportunities: JobOpportunity[];
}) {
  return `Build an exhaustive requirement-to-evidence matrix for the supplied vacancy.

Candidate evidence packets (each vacancy has a retrieved canonical subset plus routed knowledge pages):
${JSON.stringify(input.assessmentEvidence, null, 2)}

Vacancies:
${JSON.stringify(vacanciesForMatching(input.opportunities), null, 2)}

Rules:
- Return the supplied jobId and one requirements array containing every distinct employer requirement.
- Extract every distinct core responsibility and explicit candidate qualification. Do not impose an arbitrary item limit.
- Extract core responsibility rows from responsibilitiesText and set category=responsibility. Extract qualifications from qualificationText. When a source is marked full_description_fallback, the employer did not expose a clean standalone section; use the supplied complete vacancy text conservatively instead of omitting the requirements or rejecting the vacancy.
- Set category=mandatory when the employer presents a qualification as a requirement, minimum, must-have, or expected capability; category=preferred only when it says preferred, bonus, or nice-to-have; category=constraint for legal, authorization, location, schedule, travel, language, or credential gates.
- Keep kind=required for responsibility, mandatory, and constraint rows; use kind=preferred only for preferred rows.
- Do not treat responsibilities, company descriptions, benefits, compensation, or interview-process text as candidate qualifications.
- Use matchClass=explicit only for direct evidence at adequate scope, strong_adjacent for the same discipline with a learnable dialect/tool/platform/context gap, weak_adjacent when transfer is plausible but material, unsupported when no evidence exists, and contradicted when evidence conflicts.
- matched corresponds to explicit; partial corresponds to strong_adjacent or weak_adjacent; missing corresponds to unsupported or contradicted. Set confidence from 0 to 1 and provide gapClass/gapSeverity for every row.
- Preserve normalized capability, minimum duration, ownership, maturity, scope, work context, tool/method, credential, ambiguity, and a narrow vacancy source locator separately. Use 0, an empty string, or an empty list when the posting does not state one.
- Use knowledgeRoutesByJob to understand broader or ambiguous capability language and to inspect deeper context. Knowledge page prose is retrieval and interpretation context, not independently citable evidence.
- Every matched or partial row must cite a supplied claimId and sourceId and copy a faithful exact excerpt from that claim's citation. Missing rows must have no evidence.
- supported claims may justify matched or partial. weakly_supported claims may justify partial only. Never cite unverified or contradicted claims.
- Ownership, maturity, scope, outcomes, and limitations are independent fields. Do not promote designed to operated, contributor to lead, or architecture to measured scale.
- Keep the requirement wording close to the employer's text.
- For every matched or partial row, write a clear 2-3 sentence explanation that synthesizes why the evidence supports the match and honestly states any limitation. The explanation must stand on its own in the UI without showing raw source excerpts.
- For a missing row, use one concise sentence stating that no supporting evidence was found.
- Do not calculate a percentage; the application derives it deterministically from the returned rows.`;
}

export function buildRecoveryInput(opportunities: JobOpportunity[]) {
  return `Your previous assessment omitted or returned no qualifications for the vacancy below. Return its jobId and one complete requirements array now, following the same evidence, classification, and 2-3 sentence explanation rules. Do not use tools, web search, shell commands, repository files, or any source outside this prompt; the vacancy text and allowed evidence were already supplied in this thread.

${JSON.stringify(vacanciesForMatching(opportunities), null, 2)}`;
}

export const inputDescription =
  "Validated vacancy text split into responsibilities and qualifications plus a bounded, vacancy-specific canonical claim ledger.";
