import type { JobSearchWorkspace } from "../contracts/job-search.js";
import {
  needsWillingWorkLocation,
  selectedWorkModes,
  willingWorkLocations,
} from "./work-preferences.js";

export function discoveryWorkIntent(workspace: JobSearchWorkspace) {
  const modes = selectedWorkModes(workspace.profile.workplace);
  return {
    workplaceModes: modes,
    willingWorkLocations: needsWillingWorkLocation(modes)
      ? willingWorkLocations(workspace.profile.targetLocations)
      : [],
    remoteEligibility: modes.includes("Remote") ? ["Any region"] : [],
    languages: workspace.profile.languages,
  };
}
