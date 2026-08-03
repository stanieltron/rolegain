import {
  assessOpportunityWithAgent,
  matchOpportunities,
} from "../shared/01-requirement-matching/index.js";
import type {
  MatchOneV1Input,
  MatchV1Input,
} from "./contracts.js";

export function matchOpportunitiesV1(input: MatchV1Input) {
  return matchOpportunities({ ...input, version: "v1" });
}

export function matchOneOpportunityV1(input: MatchOneV1Input) {
  return assessOpportunityWithAgent(
    input.codex,
    input.cwd,
    input.dataRoot,
    input.workspace,
    input.opportunity,
    input.model,
    "v1",
  );
}
