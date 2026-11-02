import type { JobSearchWorkspace } from "../contracts/job-search.js";

export function profileEvidenceNeedsAnalysis(
  workspace: Pick<JobSearchWorkspace, "intelligence" | "sources">,
  hasStagedEvidence: boolean,
) {
  const profileReady =
    workspace.intelligence.status === "ready" &&
    workspace.intelligence.evidenceRun?.readyForSearch !== false;
  return (
    hasStagedEvidence ||
    workspace.intelligence.status === "failed" ||
    workspace.intelligence.evidenceRun?.readyForSearch === false ||
    workspace.sources.some(
      (source) =>
        source.analysisRequired ||
        (source.status === "analysis_failed" &&
          (source.kind === "cv" || !profileReady)),
    )
  );
}

export function sourceErrorMessage(error: string) {
  // Also explain errors persisted before the redirect-limit message was added.
  if (error === "Too many redirects while reading the source") {
    return "This link exceeded the redirect limit. The website may be redirecting in a loop. Provide a more direct link to the page or upload the document instead.";
  }
  return error;
}
