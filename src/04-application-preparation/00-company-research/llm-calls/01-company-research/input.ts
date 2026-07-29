import type { JobOpportunity } from "../../../../contracts/job-search.js";

export function buildInput(job: JobOpportunity) {
  return `Research the company behind this application. Find useful facts beyond the vacancy text so later application materials can be tailored accurately.

Application:
${JSON.stringify(
  {
    company: job.company,
    title: job.title,
    sourceUrl: job.sourceUrl,
    applyUrl: job.applyUrl,
    vacancySummary: job.summary,
    vacancyDescription: job.description,
    requirements: job.requirements,
  },
  null,
  2,
)}

Research rules:
- Resolve the correct legal or trading entity using the vacancy and application URLs; do not mix similarly named businesses.
- Search the public web. Prefer the company's official website, product pages, about page, reputable profiles, and recent first-party announcements.
- Explain what the company actually builds or provides, who it serves, and how it appears to make money when sources support that.
- Capture culture, operating values, and recent strategic signals only when explicitly supported.
- Derive concise tailoring angles relevant to this exact role, but do not make claims about the candidate.
- Do not repeat vacancy copy as company research unless an external source independently adds useful context.
- Every material claim must be represented by at least one returned source evidence statement.
- Return only public HTTP(S) source URLs. Return fewer facts rather than speculate.`;
}

export const inputDescription =
  "One application-stage vacancy with company identity, vacancy URLs, description, and requirements.";
