import type { FormField } from "../../../../contracts/job-search.js";
import type { ObservedApplicationField } from "../../../../search-match-shared/types.js";

export function buildInput(input: {
  observed: ObservedApplicationField[];
  mapped: FormField[];
}) {
  return `Compare the complete observed employer schema with Agent1's mapping. Return an empty issues array only when every logical question is represented exactly once and faithfully.\n${JSON.stringify(
    input,
    null,
    2,
  )}`;
}

export const inputDescription =
  "Complete observed form schema and mapped application fields.";
