import { llmCallCatalog } from "../../../src/backend/control-flow/llm-call-catalog.js";
import { runnableStages } from "../../../src/backend/control-flow/stage-registry.js";
import { LLM_EVAL_CASES } from "./cases.js";

export interface FlowEvalCase {
  id: string;
  pipeline: "01-evidence-ingestion" | "02-search" | "03-match" | "04-application-preparation";
  stages: string[];
  callIds: string[];
  handoff: {
    input: string;
    output: string;
  };
}

export const FLOW_EVAL_CASES: FlowEvalCase[] = [
  {
    id: "evidence-ingestion.flow",
    pipeline: "01-evidence-ingestion",
    stages: ["02-chunk-reader", "03-synthesis", "04-verification"],
    callIds: [
      "evidence.chunk-analysis",
      "evidence.chunk-coverage",
      "evidence.chunk-repair",
      "evidence.synthesis",
    ],
    handoff: {
      input: "one or more evidence sources",
      output: "canonical evidence run with readiness manifest",
    },
  },
  {
    id: "search.flow",
    pipeline: "02-search",
    stages: ["01-discovery", "02-vacancy-source-expansion", "03-vacancy-validation"],
    callIds: [
      "search.web-discovery",
      "search.source-navigation",
      "search.listing-extraction",
      "search.vacancy-verification",
    ],
    handoff: {
      input: "search-ready workspace with exact evidence-run id",
      output: "validated opportunities, failures, and seen URLs",
    },
  },
  {
    id: "match.requirement-flow",
    pipeline: "03-match",
    stages: ["01-requirement-matching"],
    callIds: [
      "match.requirements",
      "match.tier2-evidence",
      "match.verification",
      "match.repair",
    ],
    handoff: {
      input:
        "validated opportunities, canonical evidence ledger, and bounded knowledge routes",
      output: "matched opportunities with verified requirement matrices",
    },
  },
  {
    id: "match.application-inspection-flow",
    pipeline: "03-match",
    stages: ["02-application-inspection"],
    callIds: [
      "application.navigate",
      "application.field-map",
      "application.schema-verify",
    ],
    handoff: {
      input: "matched opportunities selected for application inspection",
      output: "mapped and independently verified application forms",
    },
  },
  {
    id: "application-preparation.flow",
    pipeline: "04-application-preparation",
    stages: ["01-context", "02-draft", "03-verification", "04-repair", "05-refinement"],
    callIds: [
      "application.draft",
      "application.verify",
      "application.repair",
      "application.cover-letter-refine",
      "application.answer-refine",
    ],
    handoff: {
      input: "matched opportunities, mapped forms, and exact evidence-run id",
      output: "verified application drafts and explicit user refinements",
    },
  },
];

export function evaluateFlowCoverage() {
  const catalogIds = new Set(llmCallCatalog.map((call) => call.id));
  const evalCaseIds = new Set(LLM_EVAL_CASES.map((testCase) => testCase.id));
  return FLOW_EVAL_CASES.map((flow) => {
    const missingCatalogCalls = flow.callIds.filter((callId) => !catalogIds.has(callId));
    const missingEvalCases = flow.callIds.filter((callId) => !evalCaseIds.has(callId));
    const missingStages = flow.stages.filter(
      (stage) =>
        !runnableStages.some(
          (candidate) =>
            candidate.pipeline === flow.pipeline && candidate.stage === stage,
        ) &&
        // Some branch stages are intentionally inside production code, not standalone CLI programs.
        !(flow.pipeline === "02-search" && stage === "02-vacancy-source-expansion"),
    );
    return {
      ...flow,
      passed:
        missingCatalogCalls.length === 0 &&
        missingEvalCases.length === 0 &&
        missingStages.length === 0,
      missingCatalogCalls,
      missingEvalCases,
      missingStages,
    };
  });
}
