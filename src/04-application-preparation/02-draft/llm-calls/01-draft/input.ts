import type { buildApplicationContext } from "../../../01-context/index.js";

type ApplicationContext = Awaited<ReturnType<typeof buildApplicationContext>>;

export function buildInput(contexts: ApplicationContext[]) {
  return `Prepare every supplied application. Create a tailored cover letter only when requiresCoverLetter is true; otherwise return an empty coverLetter. Answer every currently empty employer field that can be answered from the supplied evidence.

For a narrative question, reread the source documents and synthesize a concise, job-relevant response when there is supporting evidence. Leave value and evidenceBasis empty when the evidence is insufficient or the field requires an unconfirmed personal fact.

Applications and grounded evidence:
${JSON.stringify(contexts, null, 2)}

Return every supplied applicationId exactly once, with an answers array (which may be empty).`;
}

export const inputDescription =
  "Verified vacancy, employer fields, candidate profile, and selected evidence documents.";
