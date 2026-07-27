import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Ajv, { type AnySchema } from "ajv";
import {
  CodexExecClient,
  type CodexRunObservation,
} from "../../../src/codex-runtime/client.js";
import type { AgentCallManifest } from "../../../src/codex-runtime/call-manifest.js";
import type { ReasoningEffort } from "../../../src/codex-runtime/llm-call-config.js";
import {
  LLM_EVAL_CASES,
  manifestForCase,
  type LlmEvalCase,
  type LlmEvalSuite,
} from "./cases.js";
import { evaluateFlowCoverage } from "./flows.js";
import { modelEffortId, type ModelEffortPair } from "./model-matrix.js";

export interface LlmEvalOptions {
  cwd: string;
  suites?: LlmEvalSuite[];
  caseIds?: string[];
  live?: boolean;
  model?: string;
  effort?: ReasoningEffort;
  concurrency?: number;
  outputRoot?: string;
  allLive?: boolean;
}

export interface LlmEvalVariant {
  id: string;
  model?: string;
  effort?: ReasoningEffort;
  baseline?: boolean;
}

export interface LlmEvalMatrixOptions extends Omit<LlmEvalOptions, "model" | "effort"> {
  candidates: ModelEffortPair[];
  includeBaseline?: boolean;
}

export interface LlmEvalTrialResult {
  id: string;
  suite: LlmEvalSuite;
  variantId?: string;
  baseline?: boolean;
  model?: string;
  effort?: ReasoningEffort;
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
  durationMs: number;
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
    effort: options.effort,
    suites: options.suites,
    cases: selectedCases.map((item) => item.id),
    flows: flowResults.map((flow) => flow.id),
  });

  let runtime: unknown;
  if (options.live) {
    const codex = new CodexExecClient(options.cwd);
    runtime = await codex.start();
    await codex.close();
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
        effort: options.effort,
      }),
  );

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

export async function runLlmCallMatrixEval(options: LlmEvalMatrixOptions) {
  if (!options.live) throw new Error("Matrix evals require --live");
  if (!options.candidates.length)
    throw new Error("Matrix evals require at least one candidate model/effort pair");

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputRoot = path.resolve(
    options.outputRoot ||
      path.join(options.cwd, ".agent-runtime", "llm-calls", "matrix-runs", timestamp),
  );
  await mkdir(outputRoot, { recursive: true });

  const selectedCases = selectCases(options);
  const flowResults = evaluateFlowCoverage();
  const variants: LlmEvalVariant[] = [
    ...(options.includeBaseline === false
      ? []
      : [{ id: "baseline", baseline: true } satisfies LlmEvalVariant]),
    ...options.candidates.map((pair) => ({
      id: modelEffortId(pair),
      model: pair.model,
      effort: pair.effort,
    })),
  ];

  await writeJson(path.join(outputRoot, "matrix-config.json"), {
    startedAt: new Date().toISOString(),
    mode: "live-matrix",
    suites: options.suites,
    cases: selectedCases.map((item) => item.id),
    allLive: options.allLive,
    variants,
    flows: flowResults.map((flow) => flow.id),
  });

  const runtimeClient = new CodexExecClient(options.cwd);
  const runtime = await runtimeClient.start();
  await runtimeClient.close();
  const jobs = variants.flatMap((variant) =>
    selectedCases.map((testCase) => ({ variant, testCase })),
  );

  const results = await mapConcurrent(
    jobs,
    Math.max(1, options.concurrency ?? 2),
    async (job) =>
      runCase({
        cwd: options.cwd,
        outputRoot,
        testCase: job.testCase,
        live: true,
        model: job.variant.model,
        effort: job.variant.effort,
        variant: job.variant,
      }),
  );

  const summary = summarizeMatrix(results, flowResults);
  await writeJson(path.join(outputRoot, "summary.json"), { ...summary, runtime });
  await writeJson(path.join(outputRoot, "flows.json"), flowResults);
  await writeFile(
    path.join(outputRoot, "trials.jsonl"),
    `${results.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outputRoot, "report.md"),
    renderMatrixReport(summary, results, flowResults),
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
  effort?: ReasoningEffort;
  variant?: LlmEvalVariant;
  codex?: CodexExecClient;
}): Promise<LlmEvalTrialResult> {
  const artifactDirectory = path.join(
    input.outputRoot,
    ...(input.variant ? [safeName(input.variant.id)] : []),
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
  let effectiveModel = input.model;
  let effectiveEffort = input.effort;
  if (input.live) {
    const codex = input.codex ?? new CodexExecClient(input.cwd);
    try {
      const live = await runLiveCase(
        input.cwd,
        codex,
        input.testCase,
        input.model,
        input.effort,
      );
      calls = live.calls;
      effectiveModel = live.model;
      effectiveEffort = live.effort;
      livePassed = live.errors.length === 0;
      errors.push(...live.errors);
      await writeJson(path.join(artifactDirectory, "live-output.json"), live.output);
      await writeJson(path.join(artifactDirectory, "calls.json"), live.calls);
    } catch (error) {
      livePassed = false;
      errors.push(error instanceof Error ? error.message : String(error));
      await writeJson(path.join(artifactDirectory, "live-output.json"), null);
      await writeJson(path.join(artifactDirectory, "calls.json"), []);
    } finally {
      if (!input.codex) await codex.close();
    }
  }

  const usage = sumUsage(calls);
  const result: LlmEvalTrialResult = {
    id: input.testCase.id,
    suite: input.testCase.suite,
    variantId: input.variant?.id,
    baseline: input.variant?.baseline,
    model: effectiveModel,
    effort: effectiveEffort,
    mode: input.live ? "live" : "contract",
    passed: errors.length === 0,
    schemaPassed: schemaErrors.length === 0,
    semanticPassed: semanticErrors.length === 0,
    livePassed,
    errors,
    calls: calls.length,
    ...usage,
    durationMs: calls.reduce((sum, call) => sum + call.durationMs, 0),
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
  effort?: ReasoningEffort,
) {
  const manifest = manifestForCase(testCase);
  const runtime = await codex.start();
  const effectiveModel = model ?? productionModel(manifest, runtime.model || "gpt-5.4");
  const effectiveEffort = effort ?? manifest.command.effort;
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
      model: effectiveModel,
      approvalPolicy: manifest.command.approvalPolicy,
      developerInstructions: manifest.rolePrompt,
      webSearch: { mode: manifest.command.webSearch },
    });
    const errors: string[] = [];
    let output: unknown = null;
    try {
      const response = await codex.runTurn({
        threadId: thread.id,
        prompt: `${testCase.prompt}\n\nReturn only JSON matching the supplied schema. Use this exact fixture id where applicable: ${testCase.id}.`,
        cwd,
        sandbox: manifest.command.sandbox,
        outputSchema: testCase.schema as Record<string, unknown>,
        model: effectiveModel,
        approvalPolicy: manifest.command.approvalPolicy,
        effort: effectiveEffort,
        timeoutMs: manifest.command.timeoutMs,
      });
      output = response.finalText;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      if (typeof output === "string") output = JSON.parse(output);
    } catch {
      errors.push("live output was not valid JSON");
    }
    errors.push(...validateSchema(testCase, output));
    errors.push(...gradeSemantics(testCase, output));
    return { output, errors, calls, model: effectiveModel, effort: effectiveEffort };
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
      (!options.live ||
        options.allLive ||
        testCase.live === "default" ||
        caseIds.has(testCase.id)),
  );
  if (!selected.length)
    throw new Error(
      options.live
        ? "No LLM eval cases selected; live evals require --cases or --all-live because cases are opt-in"
        : "No LLM eval cases selected",
    );
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
    durationMs: results.reduce((sum, item) => sum + item.durationMs, 0),
  };
}

function summarizeMatrix(
  results: LlmEvalTrialResult[],
  flowResults: ReturnType<typeof evaluateFlowCoverage>,
) {
  const summary = summarize(results, flowResults);
  const variants = [...new Set(results.map((item) => item.variantId || "single"))].map(
    (variantId) => {
      const items = results.filter((item) => (item.variantId || "single") === variantId);
      const passed = items.filter((item) => item.passed).length;
      return {
        variantId,
        model: items[0]?.model,
        effort: items[0]?.effort,
        baseline: Boolean(items[0]?.baseline),
        passed,
        failed: items.length - passed,
        total: items.length,
        calls: items.reduce((sum, item) => sum + item.calls, 0),
        totalTokens: items.reduce((sum, item) => sum + item.totalTokens, 0),
        durationMs: items.reduce((sum, item) => sum + item.durationMs, 0),
      };
    },
  );
  const cases = [...new Set(results.map((item) => item.id))].map((caseId) => {
    const items = results.filter((item) => item.id === caseId);
    const baseline = items.find((item) => item.baseline);
    const bestPassing = items
      .filter((item) => !item.baseline && item.passed)
      .sort((left, right) => left.durationMs - right.durationMs)[0];
    return {
      caseId,
      baseline: baseline && resultBrief(baseline),
      bestPassing: bestPassing && resultBrief(bestPassing),
    };
  });
  return { ...summary, variants, cases };
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
    `Duration: ${formatDuration(summary.durationMs)}`,
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

function renderMatrixReport(
  summary: ReturnType<typeof summarizeMatrix>,
  results: LlmEvalTrialResult[],
  flowResults: ReturnType<typeof evaluateFlowCoverage>,
) {
  const lines = [
    "# LLM Call Matrix Eval Report",
    "",
    `Cases: ${summary.passed}/${summary.total} passed`,
    `Flows: ${summary.flowPassed}/${summary.flowTotal} passed`,
    `Calls: ${summary.calls}`,
    `Tokens: ${summary.totalTokens}`,
    `Duration: ${formatDuration(summary.durationMs)}`,
    "",
    "## Variant Totals",
    "",
    "| Variant | Model | Effort | Passed | Duration | Tokens |",
    "| --- | --- | --- | ---: | ---: | ---: |",
    ...summary.variants.map(
      (variant) =>
        `| ${variant.variantId} | ${variant.model || ""} | ${variant.effort || ""} | ${variant.passed}/${variant.total} | ${formatDuration(variant.durationMs)} | ${variant.totalTokens} |`,
    ),
    "",
    "## Fastest Passing Candidate Per Call",
    "",
    "| Call | Baseline | Fastest passing candidate | Duration delta | Token delta |",
    "| --- | --- | --- | ---: | ---: |",
    ...summary.cases.map((item) => {
      const baseline = item.baseline;
      const best = item.bestPassing;
      return `| ${item.caseId} | ${formatBrief(baseline)} | ${formatBrief(best)} | ${formatDelta(best?.durationMs, baseline?.durationMs, "ms")} | ${formatDelta(best?.totalTokens, baseline?.totalTokens)} |`;
    }),
    "",
    "## Failed Results",
    "",
    ...results
      .filter((item) => !item.passed)
      .map(
        (item) =>
          `- ${item.id} ${item.variantId || ""}: ${item.errors.join("; ")}`,
      ),
    "",
    "## All Candidate Results",
    "",
    "| Call | Variant | Passed | Duration | Tokens |",
    "| --- | --- | --- | ---: | ---: |",
    ...results.map(
      (item) =>
        `| ${item.id} | ${item.variantId || "single"} | ${item.passed ? "PASS" : "FAIL"} | ${formatDuration(item.durationMs)} | ${item.totalTokens} |`,
    ),
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

function productionModel(manifest: AgentCallManifest, runtimeModel: string) {
  const configured = process.env[manifest.command.modelEnvironment];
  if (configured) return configured;
  if (manifest.command.defaultModel === "runtime default") return runtimeModel;
  return manifest.command.defaultModel;
}

function resultBrief(result: LlmEvalTrialResult) {
  return {
    variantId: result.variantId,
    model: result.model,
    effort: result.effort,
    passed: result.passed,
    durationMs: result.durationMs,
    totalTokens: result.totalTokens,
  };
}

function formatBrief(result: ReturnType<typeof resultBrief> | undefined) {
  if (!result) return "-";
  const status = result.passed ? "PASS" : "FAIL";
  const label = result.variantId || `${result.model || ""}-${result.effort || ""}`;
  return `${label} ${status} (${formatDuration(result.durationMs)}, ${result.totalTokens} tok)`;
}

function formatDelta(value: number | undefined, baseline: number | undefined, suffix = "") {
  if (value === undefined || baseline === undefined) return "-";
  const delta = value - baseline;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta}${suffix}`;
}

function formatDuration(durationMs: number) {
  if (!durationMs) return "0 ms";
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(1)} s`;
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
