import type { SearchPipelineItem } from "../contracts/job-search.js";

interface PipelineIdentity {
  company: string;
  title: string;
  sourceUrl: string;
  applyUrl?: string;
}

export function normalizeJobUrl(value: string) {
  try {
    const url = new URL(value);
    const hostname = /^(?:boards|job-boards)\.greenhouse\.io$/i.test(
      url.hostname,
    )
      ? "boards.greenhouse.io"
      : url.hostname.toLowerCase();
    return `${hostname}${url.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function normalizeIdentityText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Pipeline records are equivalent only when both their vacancy URL and their
 * employer/title identity agree. The text check prevents two jobs discovered
 * from the same employer landing page from being collapsed together.
 */
export function samePipelineVacancy(
  left: PipelineIdentity,
  right: PipelineIdentity,
) {
  if (
    normalizeIdentityText(left.company) !==
      normalizeIdentityText(right.company) ||
    normalizeIdentityText(left.title) !== normalizeIdentityText(right.title)
  )
    return false;
  const leftUrls = new Set(
    [left.sourceUrl, left.applyUrl]
      .filter((value): value is string => Boolean(value?.trim()))
      .map(normalizeJobUrl),
  );
  return [right.sourceUrl, right.applyUrl]
    .filter((value): value is string => Boolean(value?.trim()))
    .some((value) => leftUrls.has(normalizeJobUrl(value)));
}

function stateProgress(state: SearchPipelineItem["validation"]) {
  if (state === "waiting") return 0;
  if (state === "running") return 1;
  return 2;
}

export function pipelineItemProgress(item: SearchPipelineItem) {
  return (
    stateProgress(item.validation) +
    stateProgress(item.match) * 10 +
    stateProgress(item.application) * 100 +
    stateProgress(item.applicationVerification) * 1_000 +
    Number(item.applicationReady) * 10_000
  );
}

/** Prefer the furthest completed representation, then its canonical number. */
export function preferPipelineItem(
  current: SearchPipelineItem,
  candidate: SearchPipelineItem,
) {
  const progress = pipelineItemProgress(candidate) - pipelineItemProgress(current);
  if (progress !== 0) return progress > 0 ? candidate : current;
  if ((candidate.jobNumber ?? -1) !== (current.jobNumber ?? -1))
    return (candidate.jobNumber ?? -1) > (current.jobNumber ?? -1)
      ? candidate
      : current;
  return candidate;
}
