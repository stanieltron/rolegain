import type { JobOpportunity } from "../contracts/job-search.js";
import type { LiveCandidate } from "./types.js";

export function progressItem(candidate: LiveCandidate) {
  return {
    id: `live-${candidate.job.id}`,
    company: candidate.company,
    title: candidate.job.title,
    sourceUrl: candidate.job.jobUrl,
    sourceGroup: candidate.job.sourceGroup,
  };
}

export function progressItemFromOpportunity(opportunity: JobOpportunity) {
  return {
    id: opportunity.id,
    jobNumber: opportunity.jobNumber,
    company: opportunity.company,
    title: opportunity.title,
    sourceUrl: opportunity.sourceUrl,
    sourceGroup: opportunity.sourceGroup,
    applicationRouteStatus: opportunity.applicationRoute?.status,
    applicationRouteReason: opportunity.applicationRoute?.reason,
  };
}
