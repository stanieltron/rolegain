import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { discoverCodexBinary } from "../src/codex-runtime/discover.js";
import { evaluateResultGateway } from "../src/codex-runtime/result-gateway.js";
import { llmCallToolViolation, resolveCodexHome } from "../src/codex-runtime/client.js";
import {
  DEFAULT_MODEL_EFFORT_MATRIX,
  modelEffortId,
  parseModelEffortPairs,
  type ModelEffortPair,
} from "../evals/llm-calls/src/model-matrix.js";

type JsonObject = Record<string, unknown>;

interface BaselineRun {
  runId: string;
  directory: string;
  promptFile: string;
  schemaFile?: string;
  configFile?: string;
  run: JsonObject;
  callId: string;
  role: string;
  model: string;
  effort: string;
  sandbox: string;
  webSearch: string;
  timeoutMs: number;
  durationMs: number;
  usage: JsonObject;
}

interface ReplayJob {
  baseline: BaselineRun;
  variant: ModelEffortPair;
}

interface ReplayResult {
  id: string;
  baselineRunId: string;
  callId: string;
  role: string;
  variantId: string;
  model: string;
  effort: string;
  status: "completed" | "failed";
  accepted: boolean;
  durationMs: number;
  usage: JsonObject;
  totalTokens: number;
  runDirectory: string;
  error?: string;
  defects?: unknown[];
}

const projectRoot = process.cwd();
const args = process.argv.slice(2);
const outputRoot = path.resolve(option("--output") || ".agent-runtime/llm-call-replays/latest");
const concurrency = Number(option("--concurrency") || "10");
const limit = optionalNumber("--limit");
const variants = option("--pairs")
  ? parseModelEffortPairs(option("--pairs") || "")
  : DEFAULT_MODEL_EFFORT_MATRIX;

const runIds = await collectRunIds();
if (!runIds.length)
  throw new Error(
    "No baseline runs found. Pass --runs, --artifact <stage-output.json>, or --artifact-root <root>.",
  );

await mkdir(outputRoot, { recursive: true });
const codexBinary = await discoverCodexBinary();
const baselineRuns = (await Promise.all(runIds.map(loadBaselineRun)))
  .filter((item): item is BaselineRun => Boolean(item))
  .slice(0, limit ?? undefined);
if (!baselineRuns.length) throw new Error("No loadable baseline runs found.");

const jobs: ReplayJob[] = baselineRuns.flatMap((baseline) =>
  variants.map((variant) => ({ baseline, variant })),
);
const startedAt = Date.now();
const resultsFile = path.join(outputRoot, "trials.jsonl");
const resultsStream = createWriteStream(resultsFile, { flags: "a" });
let completed = 0;

console.log(
  JSON.stringify({
    outputRoot,
    codexBinary,
    baselineRuns: baselineRuns.length,
    variants: variants.map(modelEffortId),
    jobs: jobs.length,
    concurrency,
  }),
);

const results = await mapConcurrent(jobs, concurrency, async (job) => {
  const result = await replay(job, codexBinary);
  completed += 1;
  resultsStream.write(`${JSON.stringify(result)}\n`);
  if (completed % 10 === 0 || completed === jobs.length)
    console.log(
      JSON.stringify({
        completed,
        total: jobs.length,
        accepted: result.accepted,
        last: `${result.callId}:${result.variantId}`,
      }),
    );
  return result;
});
resultsStream.end();

const summary = summarize(baselineRuns, results);
await writeJson(path.join(outputRoot, "summary.json"), summary);
await writeFile(path.join(outputRoot, "report.md"), renderReport(summary), "utf8");
console.log(
  JSON.stringify({
    outputRoot,
    report: path.join(outputRoot, "report.md"),
    trials: resultsFile,
    accepted: results.filter((item) => item.accepted).length,
    total: results.length,
    durationMs: Date.now() - startedAt,
  }),
);

async function collectRunIds() {
  const ids = new Set<string>();
  for (const id of split(option("--runs"))) ids.add(id);
  for (const file of multiOption("--artifact")) {
    for (const id of await runIdsFromArtifact(path.resolve(file))) ids.add(id);
  }
  for (const root of multiOption("--artifact-root")) {
    for (const file of await findArtifactFiles(path.resolve(root))) {
      for (const id of await runIdsFromArtifact(file)) ids.add(id);
    }
  }
  return [...ids].sort();
}

async function runIdsFromArtifact(file: string) {
  const artifact = asRecord(JSON.parse(await readFile(file, "utf8")));
  const containers = [
    artifact,
    asRecord(artifact.data),
    asRecord(artifact.diagnostics),
    asRecord(asRecord(artifact.data).diagnostics),
  ];
  const ids = new Set<string>();
  for (const container of containers) {
    for (const value of [container.codexRuns, container.runs]) {
      if (Array.isArray(value))
        for (const item of value) if (typeof item === "string") ids.add(item);
    }
  }
  return [...ids];
}

async function findArtifactFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && (entry.name === "stage-output.json" || entry.name === "output.json"))
        found.push(full);
    }
  }
  await walk(root);
  return found;
}

async function loadBaselineRun(runId: string): Promise<BaselineRun | undefined> {
  const directory = path.join(projectRoot, ".agent-runtime", "runs", runId);
  const runFile = path.join(directory, "run.json");
  if (!(await exists(runFile))) {
    console.warn(`Missing baseline run directory for ${runId}`);
    return undefined;
  }
  const run = asRecord(JSON.parse(await readFile(runFile, "utf8")));
  if (run.status !== "completed") return undefined;
  const promptFile = path.join(directory, "prompt.txt");
  const schemaFile = path.join(directory, "schema.json");
  return {
    runId,
    directory,
    promptFile,
    schemaFile: (await exists(schemaFile)) ? schemaFile : undefined,
    configFile: (await exists(path.join(directory, "llm-config.json")))
      ? path.join(directory, "llm-config.json")
      : undefined,
    run,
    callId: stringValue(run.callId),
    role: stringValue(run.role),
    model: stringValue(run.model),
    effort: stringValue(run.effort),
    sandbox: stringValue(run.sandbox),
    webSearch: stringValue(run.webSearch),
    timeoutMs: numberValue(run.timeoutMs, 300_000),
    durationMs: numberValue(run.durationMs, 0),
    usage: asRecord(run.usage),
  };
}

async function replay(job: ReplayJob, codexBinary: string): Promise<ReplayResult> {
  const id = `${job.baseline.runId}__${modelEffortId(job.variant)}`;
  const runDirectory = path.join(
    outputRoot,
    "runs",
    safeName(job.baseline.callId),
    safeName(job.baseline.runId),
    modelEffortId(job.variant),
  );
  const executionCwd = path.join(runDirectory, "isolated-workspace");
  await mkdir(executionCwd, { recursive: true });
  await copyBaselineSkills(job.baseline, executionCwd);

  const prompt = await readFile(job.baseline.promptFile, "utf8");
  const schema = job.baseline.schemaFile
    ? asRecord(JSON.parse(await readFile(job.baseline.schemaFile, "utf8")))
    : undefined;
  const resultPath = path.join(runDirectory, "result.json");
  const rawResultPath = path.join(runDirectory, "result.raw.json");
  const schemaPath = path.join(runDirectory, "schema.json");
  const promptPath = path.join(runDirectory, "prompt.txt");
  const eventsPath = path.join(runDirectory, "events.jsonl");
  const stderrPath = path.join(runDirectory, "stderr.log");
  const gatewayPath = path.join(runDirectory, "gateway.json");
  const runPath = path.join(runDirectory, "run.json");
  await writeFile(promptPath, prompt, "utf8");
  if (schema) await writeJson(schemaPath, schema);
  await writeJson(runPath, {
    replayOf: job.baseline.runId,
    callId: job.baseline.callId,
    role: job.baseline.role,
    baseline: {
      model: job.baseline.model,
      effort: job.baseline.effort,
      durationMs: job.baseline.durationMs,
      usage: job.baseline.usage,
    },
    model: job.variant.model,
    effort: job.variant.effort,
    sandbox: job.baseline.sandbox,
    webSearch: job.baseline.webSearch,
    timeoutMs: job.baseline.timeoutMs,
    startedAt: new Date().toISOString(),
    status: "running",
  });

  const started = Date.now();
  const args = [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--config",
    `service_tier="${process.env.ROLEGAIN_SERVICE_TIER || "fast"}"`,
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "--sandbox",
    job.baseline.sandbox === "workspaceWrite" ? "workspace-write" : "read-only",
    "--cd",
    executionCwd,
    "--output-last-message",
    resultPath,
    "--model",
    job.variant.model,
    "--config",
    `model_reasoning_effort="${job.variant.effort}"`,
    "--config",
    "features.shell_tool=false",
    "--config",
    "features.apps=false",
    "--config",
    "features.remote_plugin=false",
  ];
  if (schema) args.push("--output-schema", schemaPath);
  args.push(
    "--config",
    job.baseline.webSearch === "live"
      ? 'web_search="live"'
      : job.baseline.webSearch === "cached"
        ? 'web_search="cached"'
        : 'web_search="disabled"',
    "-",
  );

  const events = createWriteStream(eventsPath, { flags: "a" });
  const stderr = createWriteStream(stderrPath, { flags: "a" });
  let usage: JsonObject = {};
  let stderrText = "";
  let policyViolation = "";
  const child = spawn(codexBinary, args, {
    cwd: executionCwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_HOME: process.env.ROLEGAIN_CODEX_HOME || process.env.CODEX_HOME || resolveCodexHome(),
      NO_COLOR: "1",
    },
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    events.write(`${line}\n`);
    const event = parseJsonObject(line);
    if (!event) return;
    const violation = llmCallToolViolation(job.baseline.callId, job.baseline.role, event);
    if (violation && !policyViolation) {
      policyViolation = violation;
      child.kill();
    }
    if (event.type === "turn.completed") usage = asRecord(event.usage);
  });
  createInterface({ input: child.stderr }).on("line", (line) => {
    stderr.write(`${line}\n`);
    stderrText = `${stderrText}${line}\n`.slice(-8_000);
  });
  child.stdin.end(prompt);

  try {
    await waitForExit(child, job.baseline.timeoutMs);
    if (policyViolation) throw new Error(policyViolation);
    const finalText = await readFile(resultPath, "utf8");
    const gateway = evaluateResultGateway({
      callId: job.baseline.callId,
      finalText,
      outputSchema: schema,
      prompt,
    });
    await writeJson(gatewayPath, gateway.report);
    if (gateway.report.adjustments.length > 0 && gateway.output !== undefined) {
      await writeFile(rawResultPath, finalText, "utf8");
      await writeJson(resultPath, gateway.output);
    }
    const durationMs = Date.now() - started;
    await writeJson(runPath, {
      ...(await readJson(runPath)),
      status: gateway.report.accepted ? "completed" : "failed",
      completedAt: new Date().toISOString(),
      durationMs,
      usage,
      gateway: gateway.report,
      artifacts: {
        promptSha256: await fileSha256(promptPath),
        schemaSha256: schema ? await fileSha256(schemaPath) : undefined,
        resultSha256: await fileSha256(resultPath),
        gatewaySha256: await fileSha256(gatewayPath),
      },
    });
    return {
      id,
      baselineRunId: job.baseline.runId,
      callId: job.baseline.callId,
      role: job.baseline.role,
      variantId: modelEffortId(job.variant),
      model: job.variant.model,
      effort: job.variant.effort,
      status: gateway.report.accepted ? "completed" : "failed",
      accepted: gateway.report.accepted,
      durationMs,
      usage,
      totalTokens: totalTokens(usage),
      runDirectory,
      defects: gateway.report.defects,
      error: gateway.report.accepted
        ? undefined
        : gateway.report.defects.map((defect) => `${defect.code}: ${defect.message}`).join("; "),
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    await writeJson(runPath, {
      ...(await readJson(runPath)),
      status: "failed",
      completedAt: new Date().toISOString(),
      durationMs,
      usage,
      error: stderrText.trim() ? `${message}: ${stderrText.trim()}` : message,
    });
    return {
      id,
      baselineRunId: job.baseline.runId,
      callId: job.baseline.callId,
      role: job.baseline.role,
      variantId: modelEffortId(job.variant),
      model: job.variant.model,
      effort: job.variant.effort,
      status: "failed",
      accepted: false,
      durationMs,
      usage,
      totalTokens: totalTokens(usage),
      runDirectory,
      error: stderrText.trim() ? `${message}: ${stderrText.trim()}` : message,
    };
  } finally {
    events.end();
    stderr.end();
  }
}

async function copyBaselineSkills(baseline: BaselineRun, executionCwd: string) {
  const source = path.join(baseline.directory, "isolated-workspace", ".agents");
  if (!(await exists(source))) return;
  await cp(source, path.join(executionCwd, ".agents"), { recursive: true });
}

function summarize(baselineRuns: BaselineRun[], results: ReplayResult[]) {
  const baselineByCall = groupBy(baselineRuns, (item) => item.callId);
  const resultsByCall = groupBy(results, (item) => item.callId);
  const calls = [...new Set([...baselineByCall.keys(), ...resultsByCall.keys()])].sort();
  return {
    createdAt: new Date().toISOString(),
    outputRoot,
    baselineRuns: baselineRuns.length,
    variants: variants.map(modelEffortId),
    totalReplays: results.length,
    acceptedReplays: results.filter((item) => item.accepted).length,
    calls: calls.map((callId) => {
      const baselines = baselineByCall.get(callId) || [];
      const callResults = resultsByCall.get(callId) || [];
      const byVariant = [...groupBy(callResults, (item) => item.variantId).entries()].map(
        ([variantId, items]) => ({
          variantId,
          model: items[0]?.model || "",
          effort: items[0]?.effort || "",
          passed: items.filter((item) => item.accepted).length,
          total: items.length,
          avgDurationMs: average(items.map((item) => item.durationMs)),
          avgTokens: average(items.map((item) => item.totalTokens)),
          totalTokens: sum(items.map((item) => item.totalTokens)),
        }),
      );
      const completePassing = byVariant
        .filter((item) => item.total > 0 && item.passed === item.total)
        .sort((a, b) => a.avgDurationMs - b.avgDurationMs);
      return {
        callId,
        baseline: {
          count: baselines.length,
          model: commonLabel(baselines.map((item) => item.model)),
          effort: commonLabel(baselines.map((item) => item.effort)),
          avgDurationMs: average(baselines.map((item) => item.durationMs)),
          avgTokens: average(baselines.map((item) => totalTokens(item.usage))),
        },
        bestCompletePassing: completePassing[0],
        variants: byVariant.sort((a, b) => {
          if (b.passed !== a.passed) return b.passed - a.passed;
          return a.avgDurationMs - b.avgDurationMs;
        }),
      };
    }),
    failures: results
      .filter((item) => !item.accepted)
      .map((item) => ({
        callId: item.callId,
        baselineRunId: item.baselineRunId,
        variantId: item.variantId,
        error: item.error,
        runDirectory: item.runDirectory,
      })),
  };
}

function renderReport(summary: ReturnType<typeof summarize>) {
  const lines = [
    "# Rolegain Real-Input LLM Replay",
    "",
    `Baseline runs: ${summary.baselineRuns}`,
    `Replay results: ${summary.acceptedReplays}/${summary.totalReplays} accepted`,
    "",
    "## Best Complete Passing Candidate Per Call",
    "",
    "| Call | Baseline | Instances | Best complete passing candidate | Avg duration delta | Avg token delta |",
    "| --- | --- | ---: | --- | ---: | ---: |",
  ];
  for (const call of summary.calls) {
    const best = call.bestCompletePassing;
    lines.push(
      `| ${call.callId} | ${call.baseline.model} ${call.baseline.effort} (${formatDuration(call.baseline.avgDurationMs)}, ${Math.round(call.baseline.avgTokens)} tok) | ${call.baseline.count} | ${
        best
          ? `${best.model} ${best.effort} (${formatDuration(best.avgDurationMs)}, ${Math.round(best.avgTokens)} tok)`
          : "no complete passing candidate"
      } | ${best ? formatDelta(best.avgDurationMs, call.baseline.avgDurationMs, "ms") : "-"} | ${
        best ? formatDelta(best.avgTokens, call.baseline.avgTokens) : "-"
      } |`,
    );
  }
  lines.push("", "## Variant Details", "");
  for (const call of summary.calls) {
    lines.push(`### ${call.callId}`, "");
    lines.push("| Variant | Passed | Avg duration | Avg tokens |");
    lines.push("| --- | ---: | ---: | ---: |");
    for (const variant of call.variants)
      lines.push(
        `| ${variant.model} ${variant.effort} | ${variant.passed}/${variant.total} | ${formatDuration(variant.avgDurationMs)} | ${Math.round(variant.avgTokens)} |`,
      );
    lines.push("");
  }
  if (summary.failures.length) {
    lines.push("## Failures", "");
    for (const failure of summary.failures.slice(0, 200))
      lines.push(
        `- ${failure.callId} ${failure.variantId} ${failure.baselineRunId}: ${failure.error || "failed"}`,
      );
    if (summary.failures.length > 200)
      lines.push(`- ... ${summary.failures.length - 200} more failures omitted from report`);
  }
  return `${lines.join("\n")}\n`;
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(new Error(`Codex exec timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    if (exit.code !== 0)
      throw new Error(`Codex exec failed (code ${exit.code}, signal ${exit.signal || "none"})`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapConcurrent<T, R>(
  items: T[],
  parallel: number,
  worker: (item: T) => Promise<R>,
) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

function groupBy<T>(items: T[], key: (item: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    grouped.set(id, [...(grouped.get(id) || []), item]);
  }
  return grouped;
}

function option(name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function multiOption(name: string) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1)
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  return values;
}

function split(value: string | undefined) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalNumber(name: string) {
  const value = option(name);
  return value ? Number(value) : undefined;
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function parseJsonObject(line: string) {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown, fallback: number) {
  return typeof value === "number" ? value : fallback;
}

function totalTokens(usage: JsonObject) {
  return usageNumber(usage, "input_tokens", "inputTokens") + usageNumber(usage, "output_tokens", "outputTokens");
}

function usageNumber(usage: JsonObject, snake: string, camel: string) {
  const value = usage[snake] ?? usage[camel];
  return typeof value === "number" ? value : 0;
}

function average(values: number[]) {
  const valid = values.filter((value) => Number.isFinite(value));
  return valid.length ? sum(valid) / valid.length : 0;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function commonLabel(values: string[]) {
  const unique = [...new Set(values.filter(Boolean))];
  return unique.length === 1 ? unique[0] : unique.join("/");
}

function formatDuration(durationMs: number) {
  if (!durationMs) return "0 ms";
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1_000).toFixed(1)} s`;
}

function formatDelta(value: number, baseline: number, suffix = "") {
  const delta = Math.round(value - baseline);
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta}${suffix}`;
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

async function exists(file: string) {
  return stat(file).then(() => true).catch(() => false);
}

async function readJson(file: string) {
  return asRecord(JSON.parse(await readFile(file, "utf8")));
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fileSha256(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}
