import type { SearchVersion } from "./config/runtime.js";
import {
  searchAndValidateOpportunities as searchV1,
} from "./02-search/v1/index.js";
import {
  searchAndValidateOpportunitiesV2 as searchV2,
  type SearchV2Input,
} from "./02-search/v2/index.js";

export type SearchImplementation = (
  input: SearchV2Input,
) => ReturnType<typeof searchV1>;

export function searchImplementationFor(
  version: SearchVersion,
): SearchImplementation {
  return version === "v2" ? searchV2 : searchV1;
}
