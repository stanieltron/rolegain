import { manifest as chunkAnalysis } from "../../01-evidence-ingestion/02-chunk-reader/llm-calls/01-chunk-analysis/index.js";
import { manifest as chunkCoverage } from "../../01-evidence-ingestion/02-chunk-reader/llm-calls/02-coverage-verification/index.js";
import { manifest as chunkRepair } from "../../01-evidence-ingestion/02-chunk-reader/llm-calls/03-chunk-repair/index.js";
import { manifest as evidenceSynthesis } from "../../01-evidence-ingestion/03-synthesis/llm-calls/01-evidence-synthesis/index.js";
import { manifest as webSearch } from "../../02-search/01-discovery/llm-calls/01-web-search/index.js";
import { manifest as sourceNavigation } from "../../02-search/02-vacancy-source-expansion/browser-agent/llm-calls/01-source-navigation/index.js";
import { manifest as listingExtraction } from "../../02-search/03-vacancy-validation/llm-calls/01-listing-extraction/index.js";
import { manifest as vacancyVerification } from "../../02-search/03-vacancy-validation/llm-calls/02-vacancy-verification/index.js";
import { manifest as requirementMatching } from "../../03-match/01-requirement-matching/llm-calls/01-requirement-matching/index.js";
import { manifest as tier2Matching } from "../../03-match/01-requirement-matching/llm-calls/02-tier2-matching/index.js";
import { manifest as matchVerification } from "../../03-match/01-requirement-matching/llm-calls/03-match-verification/index.js";
import { manifest as matchRepair } from "../../03-match/01-requirement-matching/llm-calls/04-match-repair/index.js";
import { manifest as applicationNavigation } from "../../03-match/02-application-inspection/llm-calls/01-application-navigation/index.js";
import { manifest as applicationFieldMapping } from "../../03-match/02-application-inspection/llm-calls/02-application-field-mapping/index.js";
import { manifest as applicationSchemaVerification } from "../../03-match/02-application-inspection/llm-calls/03-application-schema-verification/index.js";
import { manifest as applicationDraft } from "../../04-application-preparation/02-draft/llm-calls/01-draft/index.js";
import { manifest as applicationVerification } from "../../04-application-preparation/03-verification/llm-calls/01-verification/index.js";
import { manifest as applicationRepair } from "../../04-application-preparation/04-repair/llm-calls/01-repair/index.js";
import { manifest as coverLetterRefinement } from "../../04-application-preparation/05-refinement/llm-calls/01-cover-letter-refinement/index.js";
import { manifest as answerRefinement } from "../../04-application-preparation/05-refinement/llm-calls/02-answer-refinement/index.js";

export const llmCallCatalog = [
  chunkAnalysis,
  chunkCoverage,
  chunkRepair,
  evidenceSynthesis,
  webSearch,
  sourceNavigation,
  listingExtraction,
  vacancyVerification,
  requirementMatching,
  tier2Matching,
  matchVerification,
  matchRepair,
  applicationNavigation,
  applicationFieldMapping,
  applicationSchemaVerification,
  applicationDraft,
  applicationVerification,
  applicationRepair,
  coverLetterRefinement,
  answerRefinement,
] as const;
