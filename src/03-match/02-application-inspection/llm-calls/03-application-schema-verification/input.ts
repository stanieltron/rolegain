import type { FormField } from "../../../../contracts/job-search.js";
import type { ObservedApplicationField } from "../../../../search-match-shared/types.js";

export function buildInput(input: {
  observed: ObservedApplicationField[];
  mapped: FormField[];
}) {
  return `Compare the complete observed employer schema with Agent1's mapping. Return an empty issues array when every logical employer question is represented once with its requiredness and choices preserved. Audit schema only: do not evaluate candidate answers, blank values, confidence, evidence, or whether required user input is missing. Do not flag URL/number-as-text, radio-as-select, an optional checkbox multi-select represented as select with all options preserved, repeated canonical keys on distinct external fields, or empty optional uploads.\n${JSON.stringify(
    input,
    null,
    2,
  )}`;
}

export const inputDescription =
  "Complete observed form schema and mapped application fields.";
