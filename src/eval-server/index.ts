import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LLM_EVAL_CASES, type LlmEvalSuite } from "../../evals/llm-calls/src/cases.js";
import { FLOW_EVAL_CASES } from "../../evals/llm-calls/src/flows.js";
import {
  runLlmCallEval,
  type LlmEvalTrialResult,
} from "../../evals/llm-calls/src/runner.js";
import { readJson, sendJson, setCors } from "../server/http.js";

type EvalTargetKind = "all" | "suite" | "llm-call" | "flow";
type EvalRunStatus = "queued" | "running" | "passed" | "failed";

interface EvalRunRequest {
  targetKind?: EvalTargetKind;
  suites?: string[];
  caseIds?: string[];
  flowIds?: string[];
  live?: boolean;
  model?: string;
  concurrency?: number;
  outputRoot?: string;
}

interface EvalRunRecord {
  id: string;
  status: EvalRunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  request: Required<Pick<EvalRunRequest, "targetKind" | "suites" | "caseIds" | "flowIds" | "live">> &
    Pick<EvalRunRequest, "model" | "concurrency" | "outputRoot">;
  outputRoot: string;
  summary?: unknown;
  report?: string;
  results?: LlmEvalTrialResult[];
  error?: string;
}

const projectRoot = process.cwd();
const runs = new Map<string, EvalRunRecord>();

const server = createServer(async (request, response) => {
  try {
    setCors(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/evals/catalog") {
      sendJson(response, 200, {
        cases: LLM_EVAL_CASES.map((testCase) => ({
          id: testCase.id,
          suite: testCase.suite,
          semanticChecks: testCase.semanticChecks,
          live: testCase.live,
        })),
        flows: FLOW_EVAL_CASES,
        suites: [...new Set(LLM_EVAL_CASES.map((testCase) => testCase.suite))],
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/evals/runs") {
      sendJson(response, 200, {
        runs: [...runs.values()]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(trimRun),
      });
      return;
    }

    const runMatch = url.pathname.match(/^\/api\/evals\/runs\/([^/]+)$/);
    if (request.method === "GET" && runMatch) {
      const run = runs.get(decodeURIComponent(runMatch[1]));
      if (!run) {
        sendJson(response, 404, { error: "Eval run not found" });
        return;
      }
      sendJson(response, 200, run);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/evals/runs") {
      const body = (await readJson(request)) as EvalRunRequest;
      const run = createEvalRun(body);
      runs.set(run.id, run);
      void executeRun(run);
      sendJson(response, 202, trimRun(run));
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, error instanceof HttpError ? error.status : 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

const port = Number(process.env.EVAL_PORT || 4327);
server.listen(port, "127.0.0.1", () => {
  console.log(`Eval API listening at http://127.0.0.1:${port}`);
});

process.once("SIGINT", () => server.close(() => process.exit(0)));
process.once("SIGTERM", () => server.close(() => process.exit(0)));

function createEvalRun(input: EvalRunRequest): EvalRunRecord {
  const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
  const targetKind = normalizeTargetKind(input.targetKind);
  const flowIds = normalizedList(input.flowIds);
  const caseIds =
    targetKind === "flow"
      ? caseIdsForFlows(flowIds)
      : normalizedList(input.caseIds);
  const suites = normalizedList(input.suites);
  validateSelection({ targetKind, suites, caseIds, flowIds, live: Boolean(input.live) });
  const outputRoot =
    input.outputRoot ||
    path.join(projectRoot, ".agent-runtime", "eval-ui", "runs", id);
  return {
    id,
    status: "queued",
    createdAt: new Date().toISOString(),
    request: {
      targetKind,
      suites,
      caseIds,
      flowIds,
      live: Boolean(input.live),
      model: cleanOptional(input.model),
      concurrency: positiveInteger(input.concurrency, 4),
      outputRoot,
    },
    outputRoot,
  };
}

async function executeRun(run: EvalRunRecord) {
  run.status = "running";
  run.startedAt = new Date().toISOString();
  try {
    const result = await runLlmCallEval({
      cwd: projectRoot,
      suites: run.request.targetKind === "suite" ? (run.request.suites as LlmEvalSuite[]) : undefined,
      caseIds:
        run.request.targetKind === "llm-call" || run.request.targetKind === "flow"
          ? run.request.caseIds
          : undefined,
      live: run.request.live,
      model: run.request.model,
      concurrency: run.request.concurrency,
      outputRoot: run.outputRoot,
    });
    run.summary = result.summary;
    run.results = result.results;
    run.report = await readFile(path.join(result.outputRoot, "report.md"), "utf8").catch(
      () => undefined,
    );
    run.status =
      result.summary.failed === 0 && result.summary.flowFailed === 0
        ? "passed"
        : "failed";
  } catch (error) {
    run.status = "failed";
    run.error = error instanceof Error ? error.stack || error.message : String(error);
  } finally {
    run.finishedAt = new Date().toISOString();
  }
}

function caseIdsForFlows(flowIds: string[]) {
  const selected = FLOW_EVAL_CASES.filter((flow) => flowIds.includes(flow.id));
  return [...new Set(selected.flatMap((flow) => flow.callIds))];
}

function normalizeTargetKind(value: unknown): EvalTargetKind {
  if (value === undefined || value === "") return "all";
  if (value === "all" || value === "suite" || value === "llm-call" || value === "flow") {
    return value;
  }
  throw new HttpError(400, "Unknown eval target");
}

function validateSelection(selection: {
  targetKind: EvalTargetKind;
  suites: string[];
  caseIds: string[];
  flowIds: string[];
  live: boolean;
}) {
  if (selection.targetKind === "suite" && selection.suites.length === 0) {
    throw new HttpError(400, "Select at least one suite, or use target All");
  }
  if (selection.targetKind === "llm-call" && selection.caseIds.length === 0) {
    throw new HttpError(400, "Select at least one LLM call, or use target All");
  }
  if (selection.targetKind === "flow" && selection.flowIds.length === 0) {
    throw new HttpError(400, "Select at least one flow, or use target All");
  }
  if (selection.live && selection.targetKind !== "llm-call" && selection.targetKind !== "flow") {
    throw new HttpError(400, "Live evals require selected LLM calls or selected flows");
  }
}

function normalizedList(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : [];
}

function cleanOptional(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function trimRun(run: EvalRunRecord) {
  const { results, report, ...summary } = run;
  return {
    ...summary,
    resultCount: results?.length ?? 0,
    hasReport: Boolean(report),
  };
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
