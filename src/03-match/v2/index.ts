import {
  assessOpportunityWithAgent,
  matchOpportunities,
} from "../shared/01-requirement-matching/index.js";
import type {
  MatchOneV2Input,
  MatchV2Input,
} from "./contracts.js";

export function matchOpportunitiesV2(input: MatchV2Input) {
  return matchOpportunities({ ...input, version: "v2" });
}

export function matchOneOpportunityV2(input: MatchOneV2Input) {
  return assessOpportunityWithAgent(
    input.codex,
    input.cwd,
    input.dataRoot,
    input.workspace,
    input.opportunity,
    input.model,
    "v2",
  );
}
