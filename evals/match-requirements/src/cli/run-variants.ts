import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexExecClient } from "../../../../src/codex-runtime/client.js";
import {
  compareTrialResults,
  type ComparableTrial,
} from "../harness/comparison.js";
import { runMatchRequirementsEval } from "../harness/runner.js";
import {
  newVariantRun,
  readNextEvalVariants,
  readVariantRuns,
  writeNextEvalVariants,
  writeVariantRuns,
  type NextEvalVariantRow,
  type VariantRunRow,
} from "../improvement/variant-tables.js";

export interface RunNextEvalVariantsOptions {
  cwd: string;
  maxVariants?: number;
}

export async function runNextEvalVariants(
  options: RunNextEvalVariantsOptions,
) {
  const queue = await readNextEvalVariants(options.cwd);
  const pending = queue
    .filter((row) => row.status === "pending")
    .slice(0, options.maxVariants ?? Number.POSITIVE_INFINITY);
  const completed: VariantRunRow[] = [];
  for (const variant of pending) {
    const run = newVariantRun(variant);
    await updateQueue(options.cwd, queue, variant.id, {
      status: "running",
      lastRunId: run.id,
      error: undefined,
    });
    const runs = await readVariantRuns(options.cwd);
    runs.push(run);
    await writeVariantRuns(options.cwd, runs);
    try {
      const model = await resolveEvaluationModel(options.cwd, variant);
      run.resolvedModel = model;
      const result = await runMatchRequirementsEval({
        cwd: options.cwd,
        models: [model],
        configuration: variant.configuration,
        trials: variant.eval.trials,
        concurrency: variant.eval.concurrency,
        caseIds: variant.eval.caseIds,
        splits: variant.eval.splits,
        suites: variant.eval.suites,
      });
      run.status = "completed";
      run.completedAt = new Date().toISOString();
      run.outputRoot = result.outputRoot;
      run.summaryPath = path.join(result.outputRoot, "summary.json");
      run.releaseGatePath = path.join(result.outputRoot, "release-gate.json");
      run.releaseStatus = result.releaseGate.status;
      run.releaseEligible = result.releaseGate.eligible;
      if (!variant.baseline)
        run.comparisonToBaseline = await compareToLatestBaseline(
          options.cwd,
          run,
        );
      await replaceRun(options.cwd, run);
      await updateQueue(options.cwd, queue, variant.id, {
        status: "completed",
        lastRunId: run.id,
        error: undefined,
      });
      completed.push(run);
    } catch (error) {
      run.status = "failed";
      run.completedAt = new Date().toISOString();
      run.error = error instanceof Error ? error.stack || error.message : String(error);
      await replaceRun(options.cwd, run);
      await updateQueue(options.cwd, queue, variant.id, {
        status: "failed",
        lastRunId: run.id,
        error: run.error,
      });
      completed.push(run);
    }
  }
  return completed;
}

async function resolveEvaluationModel(
  cwd: string,
  variant: NextEvalVariantRow,
) {
  const configuredModels = Object.values(variant.configuration.overrides || {})
    .map((override) => override?.model)
    .filter((model): model is string => Boolean(model));
  if (configuredModels.length) return configuredModels[0];
  const client = new CodexExecClient(cwd);
  const runtime = await client.start();
  await client.close();
  return (
    process.env.ROLEGAIN_FAST_MODEL ||
    runtime.models.find((item) => item.id === "gpt-5.4-mini")?.id ||
    runtime.model ||
    "gpt-5.4-mini"
  );
}

async function compareToLatestBaseline(cwd: string, candidate: VariantRunRow) {
  const runs = await readVariantRuns(cwd);
  const baseline = [...runs]
    .reverse()
    .find(
      (row) =>
        row.baseline &&
        row.status === "completed" &&
        row.outputRoot &&
        row.id !== candidate.id,
    );
  if (!baseline?.outputRoot || !candidate.outputRoot) return undefined;
  const [baselineTrials, candidateTrials] = await Promise.all([
    loadTrials(baseline.outputRoot),
    loadTrials(candidate.outputRoot),
  ]);
  const rows = compareTrialResults(baselineTrials, candidateTrials);
  const eligible = rows.length > 0 && rows.every((row) => row.eligible);
  const decision: NonNullable<
    VariantRunRow["comparisonToBaseline"]
  >["decision"] = !eligible
    ? "ineligible"
    : rows.some((row) => row.decision === "regression")
      ? "regression"
      : rows.some((row) => row.decision === "inconclusive")
        ? "inconclusive"
        : "non_inferior";
  const reportPath = path.join(candidate.outputRoot, "baseline-comparison.json");
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        baselineRunId: baseline.id,
        baselineOutputRoot: baseline.outputRoot,
        candidateRunId: candidate.id,
        candidateOutputRoot: candidate.outputRoot,
        eligible,
        decision,
        rows,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { baselineRunId: baseline.id, eligible, decision, reportPath };
}

async function loadTrials(root: string) {
  return (await readFile(path.join(root, "trials.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ComparableTrial);
}

async function updateQueue(
  cwd: string,
  rows: NextEvalVariantRow[],
  id: string,
  patch: Partial<NextEvalVariantRow>,
) {
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) throw new Error(`Unknown next eval variant ${id}`);
  rows[index] = {
    ...rows[index],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeNextEvalVariants(cwd, rows);
}

async function replaceRun(cwd: string, run: VariantRunRow) {
  const rows = await readVariantRuns(cwd);
  const index = rows.findIndex((row) => row.id === run.id);
  if (index < 0) rows.push(run);
  else rows[index] = run;
  await writeVariantRuns(cwd, rows);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cwd = path.resolve(here, "../../../..");
  const maxIndex = process.argv.indexOf("--max");
  const maxVariants =
    maxIndex >= 0 ? Number(process.argv[maxIndex + 1]) : undefined;
  if (
    maxVariants !== undefined &&
    (!Number.isInteger(maxVariants) || maxVariants < 1)
  )
    throw new Error("--max must be a positive integer");
  const results = await runNextEvalVariants({ cwd, maxVariants });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}
