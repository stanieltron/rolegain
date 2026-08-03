/** Enable every independently versioned v2 pipeline for a process. */
export function enableV2PipelineVersions(
  environment: NodeJS.ProcessEnv = process.env,
) {
  environment.ROLEGAIN_SEARCH_VERSION = "v2";
  environment.ROLEGAIN_EVIDENCE_VERSION = "v2";
  environment.ROLEGAIN_MATCH_VERSION = "v2";
  return environment;
}
