import type { VacancyPageSnapshot } from "../../interpreter.js";

export function buildInput(input: {
  snapshot: VacancyPageSnapshot;
  candidateIntent: {
    location: string;
    workplace: string;
    employmentTypes: string;
    skills: string[];
    summary: string;
  };
  limit: number;
}) {
  return `Extract up to ${input.limit} relevant concrete vacancies from this captured page.

Candidate intent:
${JSON.stringify(input.candidateIntent, null, 2)}

Captured page:
${JSON.stringify(
  {
    pageUrl: input.snapshot.pageUrl,
    pageTitle: input.snapshot.pageTitle,
    metaDescription: input.snapshot.metaDescription,
    headings: input.snapshot.headings.slice(0, 120),
    applyLinks: input.snapshot.applyLinks.slice(0, 50),
    links: input.snapshot.links.slice(0, 300),
    visibleText: input.snapshot.bodyText.slice(0, 100_000),
  },
  null,
  2,
)}

Rules:
- Include a row only when the page explicitly names a concrete position relevant to the candidate.
- A category/list page may yield individual job links. An employer page may yield multiple same-page vacancies sharing one form.
- jobUrl and applyUrl must be the captured page URL or exact captured URLs. When a same-page vacancy uses a shared form, use pageUrl for jobUrl and the captured form/apply URL when present, otherwise pageUrl.
- Use openStatus closed for explicit expiry/closure. Do not treat an old undated search snippet as fresh.
- description and evidence must be faithful page excerpts; do not synthesize missing requirements.
- Leave unknown fields empty.`;
}

export const inputDescription =
  "One frozen listing-page snapshot, captured links, and bounded candidate intent.";
