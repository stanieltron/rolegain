import type {
  SearchPipelineItem,
  SearchPipelineState,
} from "../contracts/job-search.js";
import {
  preferPipelineItem,
  samePipelineVacancy,
} from "../search-match-shared/job-identity.js";

export type PipelineDisplayStage = "validation" | "match" | "application";

export function coalescePipelineItems(items: SearchPipelineItem[]) {
  const result: SearchPipelineItem[] = [];
  for (const candidate of items) {
    const existingIndex = result.findIndex(
      (item) => item.id === candidate.id || samePipelineVacancy(item, candidate),
    );
    if (existingIndex < 0) {
      result.push(candidate);
      continue;
    }
    const existing = result[existingIndex];
    result[existingIndex] =
      existing.id === candidate.id
        ? candidate
        : preferPipelineItem(existing, candidate);
  }
  return result;
}

export function isManualReviewPipelineItem(item: SearchPipelineItem) {
  return item.validationDisposition === "manual_review";
}

export function isLowMatchPipelineItem(
  item: SearchPipelineItem,
  minimumMatchScore: number,
) {
  return (
    pipelineDisplayStage(item) === "match" &&
    item.match === "passed" &&
    typeof item.fit === "number" &&
    item.fit < minimumMatchScore
  );
}

/**
 * Normal mode is an action-oriented view: terminal diagnostics disappear,
 * except for manual-review and below-threshold jobs the candidate can choose
 * to promote. Developer mode preserves the complete state-machine history.
 */
export function pipelineItemVisible(
  item: SearchPipelineItem,
  stage: PipelineDisplayStage,
  developerMode: boolean,
  minimumMatchScore: number,
) {
  if (developerMode) return true;
  if (stage !== "application" && isManualReviewPipelineItem(item)) return true;
  if (stage === "match" && isLowMatchPipelineItem(item, minimumMatchScore))
    return true;

  const state =
    stage === "validation"
      ? item.validation
      : stage === "match"
        ? item.match
        : applicationOutcomeState(item);
  if (state === "failed" || state === "bench") return false;
  if (stage === "match" && item.application === "bench") return false;
  if (
    stage === "application" &&
    (item.application === "bench" || item.applicationVerification === "bench")
  )
    return false;
  return true;
}

export function isApplicationAttempt(item: SearchPipelineItem) {
  return (
    item.application === "selected" ||
    item.application === "running" ||
    item.application === "passed" ||
    item.application === "failed" ||
    item.applicationVerification !== "waiting"
  );
}

export function applicationOutcomeState(
  item: SearchPipelineItem,
): SearchPipelineState {
  if (item.applicationVerification === "passed") return "passed";
  if (
    item.application === "failed" ||
    item.applicationVerification === "failed"
  )
    return "failed";
  if (
    item.application === "running" ||
    item.applicationVerification === "running"
  )
    return "running";
  if (item.application === "passed" || item.application === "selected")
    return "selected";
  return item.application;
}

export function settlePipelineItemForDisplay(
  item: SearchPipelineItem,
  terminal: boolean,
): SearchPipelineItem {
  if (!terminal) return item;
  return {
    ...item,
    validation: item.validation === "running" ? "bench" : item.validation,
    match: item.match === "running" ? "bench" : item.match,
    application:
      item.application === "running"
        ? "failed"
        : item.application === "waiting" && item.match === "passed"
          ? "bench"
          : item.application,
    applicationVerification:
      item.applicationVerification === "running"
        ? "failed"
        : item.applicationVerification,
  };
}

export function sortApplicationAttempts(items: SearchPipelineItem[]) {
  const order: Record<SearchPipelineState, number> = {
    passed: 0,
    selected: 1,
    running: 1,
    waiting: 1,
    bench: 1,
    failed: 2,
  };
  return [...items].sort((left, right) => {
    const outcomeOrder =
      order[applicationOutcomeState(left)] -
      order[applicationOutcomeState(right)];
    if (outcomeOrder !== 0) return outcomeOrder;
    return (right.jobNumber ?? -1) - (left.jobNumber ?? -1);
  });
}

/**
 * A job belongs to exactly one board column: the furthest stage it reached.
 * Passing validation moves it to matching, and any application attempt moves
 * it to application preparation, including failed attempts.
 */
export function pipelineDisplayStage(
  item: SearchPipelineItem,
): PipelineDisplayStage {
  if (isApplicationAttempt(item)) return "application";
  if (item.validation === "passed" || item.match !== "waiting") return "match";
  return "validation";
}

export function sortPipelineRows(
  items: SearchPipelineItem[],
  currentItemIds: ReadonlySet<string>,
  stage: PipelineDisplayStage,
) {
  const succeeded = (item: SearchPipelineItem) => {
    if (stage === "validation") return item.validation === "passed";
    if (stage === "match") return item.match === "passed";
    return applicationOutcomeState(item) === "passed";
  };

  return [...items].sort((left, right) => {
    const currentOrder =
      Number(currentItemIds.has(right.id)) - Number(currentItemIds.has(left.id));
    if (currentOrder !== 0) return currentOrder;

    const successOrder = Number(succeeded(right)) - Number(succeeded(left));
    if (successOrder !== 0) return successOrder;

    const leftNumber = left.jobNumber ?? Number.MAX_SAFE_INTEGER;
    const rightNumber = right.jobNumber ?? Number.MAX_SAFE_INTEGER;
    if (leftNumber !== rightNumber) return leftNumber - rightNumber;
    return left.id.localeCompare(right.id);
  });
}
