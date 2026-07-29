import type { buildApplicationContext } from "../../../01-context/index.js";

type ApplicationContext = Awaited<ReturnType<typeof buildApplicationContext>>;

export function buildInput(input: {
  originalCv: string;
  context: ApplicationContext;
}) {
  return `Create a complete tailored CV for this one application.

Original CV — the strict factual boundary:
<original_cv>
${input.originalCv}
</original_cv>

Application context:
${JSON.stringify(input.context, null, 2)}

Rules:
- Return a complete CV, not editing advice or a partial section.
- Preserve the candidate's identity, employers, role names, dates, qualifications, metrics, and contact facts exactly unless only formatting changes.
- Reorder sections and bullets to emphasize experience that is genuinely relevant to the supplied job.
- You may make wording clearer and more concise, but do not add a skill, achievement, responsibility, customer, domain, seniority, duration, metric, or credential that is not supported by the original CV.
- Company research may guide emphasis and vocabulary, but it is not evidence about the candidate.
- Do not hide material career history merely because it is less relevant.
- Use simple Markdown headings, paragraphs, and bullet lists so the result can be rendered into DOCX.
- changeSummary must describe only meaningful tailoring changes.`;
}

export const inputDescription =
  "One original CV plus one application-stage context containing the matched vacancy, sourced company research, and candidate evidence.";
