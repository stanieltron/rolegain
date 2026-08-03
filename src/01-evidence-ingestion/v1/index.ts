import { readCandidateSourceChunks } from "./02-chunk-reader/index.js";

export { CodexCandidateAnalyzer as CodexCandidateAnalyzerV1 } from "../evidence-ingestion.js";
export { readCandidateSourceChunks };
export type ReadCandidateSourceChunksInput = Parameters<
  typeof readCandidateSourceChunks
>[0];
