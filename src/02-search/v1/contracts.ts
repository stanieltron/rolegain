import type { searchAndValidateOpportunities } from "./01-discovery/index.js";

export type SearchV1Input = Parameters<typeof searchAndValidateOpportunities>[0];
export type SearchV1Output = Awaited<ReturnType<typeof searchAndValidateOpportunities>>;
