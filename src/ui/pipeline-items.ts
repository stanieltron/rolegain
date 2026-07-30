import type {
  SearchPipelineItem,
  SearchPipelineState,
} from "../contracts/job-search.js";

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
      item.application === "running" ? "failed" : item.application,
    applicationVerification:
      item.applicationVerification === "running"
        ? "failed"
        : item.applicationVerification,
  };
}
