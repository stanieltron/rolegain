import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  compareTrialResults,
  type ComparableTrial,
} from "../harness/comparison.js";

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath)
  throw new Error(
    "Usage: tsx compare.ts BASELINE_RUN_OR_SUMMARY CANDIDATE_RUN_OR_SUMMARY",
  );

const [baseline, candidate] = await Promise.all([
  loadRun(baselinePath),
  loadRun(candidatePath),
]);
const configurationChecks = [
  equalityCheck(
    "corpusVersion",
    baseline.config.corpusVersion,
    candidate.config.corpusVersion,
  ),
  equalityCheck("trials", baseline.config.trials, candidate.config.trials),
  equalityCheck("cases", baseline.config.cases, candidate.config.cases),
  equalityCheck("suites", baseline.config.suites, candidate.config.suites),
  equalityCheck(
    "runtime.version",
    baseline.config.runtime?.version,
    candidate.config.runtime?.version,
  ),
  booleanCheck(
    "baseline.runtimeCompatible",
    Boolean(baseline.config.runtime?.compatible),
  ),
  booleanCheck(
    "candidate.runtimeCompatible",
    Boolean(candidate.config.runtime?.compatible),
  ),
];
const rows = compareTrialResults(baseline.trials, candidate.trials);
const configurationEligible = configurationChecks.every((check) => check.passed);
const eligible = configurationEligible && rows.every((row) => row.eligible);
const decision = !eligible
  ? "ineligible"
  : rows.some((row) => row.decision === "regression")
    ? "regression"
    : rows.some((row) => row.decision === "inconclusive")
      ? "inconclusive"
      : "non_inferior";

process.stdout.write(
  `${JSON.stringify(
    {
      baseline: baseline.root,
      candidate: candidate.root,
      eligible,
      decision,
      configurationChecks,
      rows,
    },
    null,
    2,
  )}\n`,
);

async function loadRun(inputPath: string) {
  const resolved = path.resolve(inputPath);
  const info = await stat(resolved);
  const root = info.isDirectory() ? resolved : path.dirname(resolved);
  const [config, trialsText] = await Promise.all([
    readFile(path.join(root, "run-config.json"), "utf8").then(JSON.parse) as Promise<RunConfig>,
    readFile(path.join(root, "trials.jsonl"), "utf8"),
  ]);
  const trials = trialsText
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ComparableTrial);
  return { root, config, trials };
}

function equalityCheck(name: string, baseline: unknown, candidate: unknown) {
  const passed = JSON.stringify(baseline) === JSON.stringify(candidate);
  return { name, baseline, candidate, passed };
}

function booleanCheck(name: string, actual: boolean) {
  return { name, actual, required: true, passed: actual };
}

interface RunConfig {
  corpusVersion: string;
  models: string[];
  trials: number;
  cases: string[];
  suites: string[];
  runtime?: { version?: string; compatible?: boolean };
}
