import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Ajv, { type AnySchema } from "ajv";
import {
  CodexExecClient,
  type CodexRunObservation,
} from "../../../src/codex-runtime/client.js";
import {
  LLM_EVAL_CASES,
  manifestForCase,
  type LlmEvalCase,
  type LlmEvalSuite,
} from "./cases.js";
import { evaluateFlowCoverage } from "./flows.js";

export interface LlmEvalOptions {
  cwd: string;
  suites?: LlmEvalSuite[];
  caseIds?: string[];
  live?: boolean;
  model?: string;
  concurrency?: number;
  outputRoot?: string;
}

export interface LlmEvalTrialResult {
  id: string;
  suite: LlmEvalSuite;
  mode: "contract" | "live";
  passed: boolean;
  schemaPassed: boolean;
  semanticPassed: boolean;
  livePassed?: boolean;
  errors: string[];
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  artifactDirectory: string;
}

const ajv = new Ajv({ allErrors: true, strict: false });

export async function runLlmCallEval(options: LlmEvalOptions) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputRoot = path.resolve(
    options.outputRoot ||
      path.join(options.cwd, ".agent-runtime", "llm-calls", "runs", timestamp),
  );
  await mkdir(outputRoot, { recursive: true });

  const selectedCases = selectCases(options);
  const flowResults = evaluateFlowCoverage();
  await writeJson(path.join(outputRoot, "run-config.json"), {
    startedAt: new Date().toISOString(),
    mode: options.live ? "live" : "contract",
    model: options.model,
    suites: options.suites,
    cases: selectedCases.map((item) => item.id),
    flows: flowResults.map((flow) => flow.id),
  });

  let codex: CodexExecClient | undefined;
  let runtime: unknown;
  if (options.live) {
    codex = new CodexExecClient(options.cwd);
    runtime = await codex.start();
  }

  const results = await mapConcurrent(
    selectedCases,
    Math.max(1, options.concurrency ?? 4),
    async (testCase) =>
      runCase({
        cwd: options.cwd,
        outputRoot,
        testCase,
        live: Boolean(options.live),
        model: options.model,
        codex,
      }),
  );
  if (codex) await codex.close();

  const summary = summarize(results, flowResults);
  await writeJson(path.join(outputRoot, "summary.json"), {
    ...summary,
    runtime,
  });
  await writeJson(path.join(outputRoot, "flows.json"), flowResults);
  await writeFile(
    path.join(outputRoot, "trials.jsonl"),
    `${results.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outputRoot, "report.md"),
    renderReport(summary, results, flowResults),
    "utf8",
  );
  return { outputRoot, results, flowResults, summary };
}

async function runCase(input: {
  cwd: string;
  outputRoot: string;
  testCase: LlmEvalCase;
  live: boolean;
  model?: string;
  codex?: CodexExecClient;
}): Promise<LlmEvalTrialResult> {
  const artifactDirectory = path.join(
    input.outputRoot,
    safeName(input.testCase.suite),
    safeName(input.testCase.id),
  );
  await mkdir(artifactDirectory, { recursive: true });
  await writeJson(path.join(artifactDirectory, "prompt.json"), {
    prompt: input.testCase.prompt,
    semanticChecks: input.testCase.semanticChecks,
  });
  await writeJson(path.join(artifactDirectory, "gold.json"), input.testCase.expected);

  const errors: string[] = [];
  const schemaErrors = validateSchema(input.testCase, input.testCase.expected);
  errors.push(...schemaErrors);
  const semanticErrors = gradeSemantics(input.testCase, input.testCase.expected);
  errors.push(...semanticErrors);

  let calls: CodexRunObservation[] = [];
  let livePassed: boolean | undefined;
  if (input.live) {
    if (!input.codex) throw new Error("Live eval requested without Codex client");
    const live = await runLiveCase(input.cwd, input.codex, input.testCase, input.model);
    calls = live.calls;
    livePassed = live.errors.length === 0;
    errors.push(...live.errors);
    await writeJson(path.join(artifactDirectory, "live-output.json"), live.output);
    await writeJson(path.join(artifactDirectory, "calls.json"), live.calls);
  }

  const usage = sumUsage(calls);
  const result: LlmEvalTrialResult = {
    id: input.testCase.id,
    suite: input.testCase.suite,
    mode: input.live ? "live" : "contract",
    passed: errors.length === 0,
    schemaPassed: schemaErrors.length === 0,
    semanticPassed: semanticErrors.length === 0,
    livePassed,
    errors,
    calls: calls.length,
    ...usage,
    artifactDirectory,
  };
  await writeJson(path.join(artifactDirectory, "trial.json"), result);
  return result;
}

async function runLiveCase(
  cwd: string,
  codex: CodexExecClient,
  testCase: LlmEvalCase,
  model?: string,
) {
  const manifest = manifestForCase(testCase);
  const calls: CodexRunObservation[] = [];
  const previous = codex.onRunCompleted;
  codex.onRunCompleted = (observation) => {
    calls.push(observation);
    previous?.(observation);
  };
  try {
    const thread = await codex.startThread({
      cwd,
      callId: testCase.id,
      role: manifest.command.role,
      sandbox: "read-only",
      model,
      approvalPolicy: manifest.command.approvalPolicy,
      developerInstructions: manifest.rolePrompt,
    });
    const response = await codex.runTurn({
      threadId: thread.id,
      prompt: `${testCase.prompt}\n\nReturn only JSON matching the supplied schema. Use this exact fixture id where applicable: ${testCase.id}.`,
      cwd,
      sandbox: manifest.command.sandbox,
      outputSchema: testCase.schema as Record<string, unknown>,
      model,
      approvalPolicy: manifest.command.approvalPolicy,
      effort: manifest.command.effort,
      timeoutMs: manifest.command.timeoutMs,
    });
    let output: unknown = response.finalText;
    const errors: string[] = [];
    try {
      output = JSON.parse(response.finalText);
    } catch {
      errors.push("live output was not valid JSON");
    }
    errors.push(...validateSchema(testCase, output));
    errors.push(...gradeSemantics(testCase, output));
    return { output, errors, calls };
  } finally {
    codex.onRunCompleted = previous;
  }
}

function validateSchema(testCase: LlmEvalCase, value: unknown) {
  const validate = ajv.compile(testCase.schema as AnySchema);
  if (validate(value)) return [];
  return [
    `${testCase.id} schema failed: ${ajv.errorsText(validate.errors, {
      separator: "; ",
    })}`,
  ];
}

function gradeSemantics(testCase: LlmEvalCase, value: unknown) {
  const errors: string[] = [];
  const record = asRecord(value);
  switch (testCase.id) {
    case "evidence.chunk-analysis":
      if (!arrayLength(record.claims)) errors.push("expected at least one evidence claim");
      if (!arrayLength(record.profileEvidence))
        errors.push("expected profile evidence with exact quote");
      break;
    case "evidence.chunk-coverage":
      if (typeof record.complete !== "boolean")
        errors.push("coverage verdict must be boolean");
      break;
    case "evidence.chunk-repair":
      if (!arrayLength(record.resolutions)) errors.push("repair must resolve findings");
      break;
    case "evidence.synthesis":
      if (!asRecord(record.profile).summary) errors.push("profile summary is required");
      if (!arrayLength(record.roleFamilies)) errors.push("role families are required");
      break;
    case "search.web-discovery":
    case "search.listing-extraction":
      if (!arrayLength(record.jobs)) errors.push("expected at least one job lead");
      break;
    case "search.source-navigation":
    case "application.navigate":
      if (!["click", "scroll", "wait", "stop"].includes(String(record.action)))
        errors.push("navigation action is outside allowed set");
      break;
    case "search.vacancy-verification":
      if (record.pageType !== "vacancy") errors.push("fixture should verify as vacancy");
      if (!arrayLength(record.evidence)) errors.push("vacancy verification needs evidence");
      break;
    case "match.requirements":
    case "match.tier2-evidence":
    case "match.repair":
      if (!arrayLength(record.requirements)) errors.push("requirements are required");
      break;
    case "match.verification":
      if (!["pass", "needs_repair"].includes(String(record.verdict)))
        errors.push("verification verdict is required");
      break;
    case "application.field-map":
      if (!arrayLength(record.fields)) errors.push("field mappings are required");
      break;
    case "application.schema-verify":
      if (!Array.isArray(record.issues)) errors.push("issues array is required");
      break;
    case "application.draft":
    case "application.repair":
      if (!arrayLength(record.drafts)) errors.push("drafts are required");
      break;
    case "application.verify":
      if (!arrayLength(record.verifications)) errors.push("verifications are required");
      break;
    case "application.cover-letter-refine":
      if (!record.coverLetter) errors.push("coverLetter is required");
      break;
    case "application.answer-refine":
      if (!record.value || !record.evidenceBasis)
        errors.push("answer refinement needs value and evidence basis");
      break;
  }
  return errors;
}

function selectCases(options: LlmEvalOptions) {
  const suites = new Set(options.suites);
  const caseIds = new Set(options.caseIds);
  const selected = LLM_EVAL_CASES.filter(
    (testCase) =>
      (!suites.size || suites.has(testCase.suite)) &&
      (!caseIds.size || caseIds.has(testCase.id)) &&
      (!options.live || testCase.live === "default" || caseIds.has(testCase.id)),
  );
  if (!selected.length) throw new Error("No LLM eval cases selected");
  return selected;
}

function summarize(
  results: LlmEvalTrialResult[],
  flowResults: ReturnType<typeof evaluateFlowCoverage>,
) {
  const passed = results.filter((item) => item.passed).length;
  const flowPassed = flowResults.filter((item) => item.passed).length;
  return {
    passed,
    failed: results.length - passed,
    total: results.length,
    flowPassed,
    flowFailed: flowResults.length - flowPassed,
    flowTotal: flowResults.length,
    calls: results.reduce((sum, item) => sum + item.calls, 0),
    totalTokens: results.reduce((sum, item) => sum + item.totalTokens, 0),
  };
}

function renderReport(
  summary: ReturnType<typeof summarize>,
  results: LlmEvalTrialResult[],
  flowResults: ReturnType<typeof evaluateFlowCoverage>,
) {
  const lines = [
    "# LLM Call Eval Report",
    "",
    `Cases: ${summary.passed}/${summary.total} passed`,
    `Flows: ${summary.flowPassed}/${summary.flowTotal} passed`,
    `Calls: ${summary.calls}`,
    `Tokens: ${summary.totalTokens}`,
    "",
    "## Failed Cases",
    "",
    ...results
      .filter((item) => !item.passed)
      .map((item) => `- ${item.id}: ${item.errors.join("; ")}`),
    "",
    "## Flow Coverage",
    "",
    ...flowResults.map((flow) =>
      `- ${flow.id}: ${flow.passed ? "PASS" : "FAIL"} (${flow.callIds.join(", ")})`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function arrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function sumUsage(calls: CodexRunObservation[]) {
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  for (const call of calls) {
    inputTokens += usageNumber(call.usage, "input_tokens", "inputTokens");
    cachedInputTokens += usageNumber(
      call.usage,
      "cached_input_tokens",
      "cachedInputTokens",
    );
    outputTokens += usageNumber(call.usage, "output_tokens", "outputTokens");
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function usageNumber(
  usage: unknown,
  snake: string,
  camel: string,
): number {
  if (!usage || typeof usage !== "object") return 0;
  const record = usage as Record<string, unknown>;
  const value = record[snake] ?? record[camel];
  return typeof value === "number" ? value : 0;
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

async function writeJson(file: string, value: unknown) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
