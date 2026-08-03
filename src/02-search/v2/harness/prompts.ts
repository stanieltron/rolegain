import type { JobSearchWorkspace } from "../../../contracts/job-search.js";
import type { Phase2EvidenceContext } from "../../../search-match-shared/evidence-context.js";
import type { SearchV2Capture } from "../contracts.js";

export const SEARCH_V2_DISCOVERY_ROLE = `You discover public-web job leads for RolegAIn search v2. Use web search only. Return concrete URLs and faithful search-result facts. Do not validate application forms, browse with shell commands, or invent vacancies. Return only the requested JSON.`;

export function buildSearchPrompt(input: {
  requested: number;
  workspace: JobSearchWorkspace;
  evidence: Phase2EvidenceContext;
  wave: number;
  excludedUrls: string[];
  rejectionFeedback: string[];
}) {
  const activeLanes = input.evidence.searchLanes.slice(
    input.wave * 3,
    input.wave * 3 + 6,
  );
  const lanes = activeLanes.length
    ? activeLanes
    : input.evidence.searchLanes.slice(0, 6);
  return `Find up to ${input.requested} strong, currently discoverable public-web results for this candidate. Finish as soon as you have concrete URLs.

Candidate:
${JSON.stringify({
  headline: input.workspace.profile.headline,
  skills: input.workspace.profile.skills,
  workplace: input.workspace.profile.workplace,
  targetLocations: input.workspace.profile.targetLocations,
  employmentTypes: input.workspace.profile.employmentTypes,
  salaryExpectation: input.workspace.profile.salaryExpectation,
}, null, 2)}

Evidence-derived role lanes:
${JSON.stringify(lanes, null, 2)}

Already seen URLs:
${JSON.stringify(input.excludedUrls.slice(-300), null, 2)}

Recent rejected-result lessons:
${JSON.stringify(input.rejectionFeedback.slice(-20), null, 2)}

Rules:
- Search several distinct role lanes; do not collapse them into one title.
- Prefer individual vacancies and employer/ATS pages.
- A useful careers page or specialist list containing relevant concrete roles may be sourceKind=job_list.
- Do not require an application form or direct Apply button at this stage.
- Skip snippets that explicitly say closed, expired, or filled.
- Remote roles are not filtered by country or timezone here.
- URLs must be absolute public HTTP(S) URLs.
- snippet is only the faithful search-result summary.
- Return fewer items rather than inventing a URL.`;
}

export const SEARCH_V2_CLASSIFIER_ROLE = `You classify frozen job-page captures for RolegAIn search v2. All evidence is supplied. Use no tools and no outside knowledge. Return only the requested JSON.`;

export function buildClassificationPrompt(captures: SearchV2Capture[]) {
  const compact = captures.map((capture) => ({
    id: capture.id,
    expectedTitle: capture.lead.title,
    expectedCompany: capture.lead.company,
    searchSourceKind: capture.lead.sourceKind,
    suppliedUrl: capture.suppliedUrl,
    finalUrl: capture.finalUrl,
    httpStatus: capture.httpStatus,
    navigationError: capture.navigationError.slice(0, 260),
    pageTitle: capture.pageTitle,
    body: capture.body.slice(0, 3_500),
    jobPosting: capture.jobPosting,
    links: capture.links.slice(0, 45),
    forms: capture.forms,
    signals: capture.signals,
  }));
  return `Classify every frozen capture as vacancy, job_list, or reject. Return every id exactly once.

Decision rules:
- vacancy: this is the current individual expected job. A form is not required. An exact titled application page still counts when its form is loading.
- job_list: this is genuinely a multi-job source. Return concrete visible child roles. If a role is expanded on the same page and has no separate URL, return the supplied page URL for that child.
- reject: wrong/absent job, definite closure, inaccessible page, or a generic talent/staffing pool rather than one concrete vacancy.
- A primarily individual job page remains vacancy even if it also contains an "other openings" section.
- Explicit full-page closure signals are authoritative. Conditional "may" or "might" language is not definite closure.
- "Open application", talent matching across several teams, or varying engagement types is a staffing pool and must be rejected.
- Prefer structured JobPosting facts, then visible page facts, then faithful search-lead facts. Never invent missing values.
- applyUrl may be the current page when no separate public HTTP(S) application URL is visible.

CAPTURES:
${JSON.stringify(compact)}`;
}
