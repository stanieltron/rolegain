import type {
  JobResearchFailure,
  SearchValidationDisposition,
  SearchValidationReasonCode,
} from "../../../contracts/job-search.js";

export interface SearchValidationClassification {
  disposition: SearchValidationDisposition;
  reasonCode: SearchValidationReasonCode;
}

/**
 * Classifies why a record stopped before matching. This deliberately defaults
 * to unresolved: an unfamiliar crawler error is not evidence that a job is
 * closed or that the candidate is ineligible.
 */
export function classifySearchValidationFailure(
  reason: string,
  stage: JobResearchFailure["stage"],
): SearchValidationClassification {
  const value = reason.replace(/\s+/g, " ").trim().toLowerCase();

  if (stage === "form")
    return { disposition: "manual_review", reasonCode: "application_form" };
  if (stage === "requirements")
    return { disposition: "unresolved", reasonCode: "matching_verification" };
  if (stage === "expired")
    return { disposition: "rejected", reasonCode: "closed_or_unavailable" };

  if (/duplicate|already validated|already retained/.test(value))
    return { disposition: "duplicate", reasonCode: "duplicate" };

  if (
    /vacancy list contained no independently validated|page classified as (?:job_list|company_page)|general careers? page|search results? page|category page/.test(
      value,
    )
  )
    return { disposition: "source_page", reasonCode: "not_a_vacancy" };

  if (
    /\b403\b|\b401\b|forbidden|cloudflare|robots(?:\.txt)?|captcha|security verification|access denied|anti[- ]?bot|bot protection|blocked by|protected, blocked/.test(
      value,
    )
  )
    return { disposition: "manual_review", reasonCode: "access_restricted" };

  if (
    /workplace or location does not match|location does not match|outside (?:the )?(?:candidate|allowed) location|onsite requirement|hybrid requirement/.test(
      value,
    )
  )
    return { disposition: "rejected", reasonCode: "location_or_workplace" };

  if (
    /page classified as closed_job|definite closure signal|explicit closure signal|page explicitly (?:says|states).*(?:closed|expired|filled|no longer (?:available|accepting))|vacancy is (?:closed|expired)|valid-through date has passed|(?:this|the) job is no longer (?:available|accepting)|position is filled|applications? (?:are|is) (?:currently )?closed/.test(
      value,
    )
  )
    return { disposition: "rejected", reasonCode: "closed_or_unavailable" };

  return { disposition: "unresolved", reasonCode: "technical_failure" };
}

export function normalizeSearchValidationFailure(
  failure: JobResearchFailure,
): JobResearchFailure {
  let classified = classifySearchValidationFailure(
    failure.reason,
    failure.stage,
  );
  if (
    classified.disposition === "rejected" &&
    isUnmistakableSearchSourcePage(failure)
  )
    classified = { disposition: "source_page", reasonCode: "not_a_vacancy" };
  return {
    ...failure,
    ...classified,
  };
}

function isUnmistakableSearchSourcePage(failure: JobResearchFailure) {
  let pathname = "";
  let host = "";
  try {
    const url = new URL(failure.sourceUrl);
    pathname = url.pathname.toLowerCase().replace(/\/$/, "");
    host = url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return (
    (host === "web3.career" && /\/[a-z0-9-]+-jobs$/.test(pathname)) ||
    (/\b(?:open positions|job openings|[a-z0-9 +./-]+ jobs)\b/i.test(
      failure.title,
    ) && /\/jobs?$|\/careers?$|\/open-positions?$/.test(pathname))
  );
}
