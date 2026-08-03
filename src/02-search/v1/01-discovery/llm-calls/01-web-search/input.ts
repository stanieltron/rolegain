export function buildInput(input: {
  requested: number;
  candidateProfile: unknown;
  canonicalPlan: unknown;
  alreadyFoundUrls: string[];
  rejectionFeedback: string[];
}) {
  return `Quickly find the best currently open public-web vacancies for this candidate. Return up to ${input.requested} strong, diverse results in best-first order as soon as you have concrete vacancy URLs.

Candidate profile and preferences:
${JSON.stringify(input.candidateProfile, null, 2)}

Canonical evidence-derived search plan:
${JSON.stringify(input.canonicalPlan, null, 2)}

Already found URLs to exclude:
${JSON.stringify(input.alreadyFoundUrls, null, 2)}

Previous validation failures to avoid in this wave:
${JSON.stringify(input.rejectionFeedback.slice(-20), null, 2)}

Search rules:
- Search across the supplied canonical role lanes rather than collapsing the candidate into one generated title. Prioritize direct lanes, include credible adjacent lanes, and use stretch lanes only when their confidence and evidence intersections are strong.
- Use the queryPortfolioForThisWave as the required starting portfolio. Keep those searches distinct; do not replace them with one broad query. You may refine a query when its results reveal a stronger employer or job-board dialect.
- Construct queries from each lane's title aliases plus one or two problem phrases, evidence intersections, or reusable tools. Do not dump every keyword into one query.
- Treat negativeTerms as exclusions when they would otherwise produce off-target results. Never use a material unknown as though it were a confirmed fact.
- Use two to four focused web_search calls when needed. Search in the candidate's stated work languages. For Remote, include only the remote-work term: do not add, prefer, or exclude any country, region, or timezone. Explicitly country-restricted remote vacancies are allowed. For Hybrid or On-site, add only willingWorkLocations. Refine later searches using useful domains and terminology found earlier. Do not use shell commands. Do not favor software, technology, crypto, or any ATS unless the evidence supports that work.
- Respect workplace, language, employment-type, and compensation constraints exactly when they are stated. For Remote, ignore geographic and timezone constraints because they are intentionally deferred to the candidate's later review.
- Do not submit or fill job pages or application forms. The next stage validates the vacancy, reads its full content, resolves the real application URL, and inspects the form.
- Prefer one concrete, individually named position per result and set sourceKind=vacancy.
- A relevant specialist listing/search page with many explicit positions may use sourceKind=job_list. An employer careers index with many explicit positions may use sourceKind=career_page. These are vacancy_search sources for a separate persistent expander, not vacancies and never enter matching themselves.
- Skip generic homepages, unrelated directories, and pages that do not visibly lead to concrete positions.
- Use a direct applyUrl only when the search result exposes an absolute HTTP(S) URL; otherwise set applyUrl to jobUrl. Never return mailto:, javascript:, relative, or private URLs.
- Exclude results whose snippet explicitly says expired, closed, speculative, duplicate, staffing-pool, or already found.
- When validation failures are supplied, avoid those exact vacancies and prefer different domains, especially employer-owned career pages and publicly accessible regional sources.
- description must be a short faithful summary of the search-result snippet; do not research a complete description.
- Return the exact discoveryQuery that produced each lead and classify sourceClass as employer_career, employer_ats, specialist_board, local_board, general_aggregator, search_engine, or employer_directory.
- Leave compensation empty when the employer does not publish it.
- Return fewer sources rather than inventing or weakening a constraint. Finish when you have enough concrete vacancies and high-quality listing or recruitment sources for the browser stage to reach ${input.requested} verified jobs.`;
}

export const inputDescription =
  "Evidence-derived role lanes and query portfolio, confirmed preferences, already-seen URLs, previous validation feedback, wave number, and requested result count.";
