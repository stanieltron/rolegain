import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LlmConfigurationSet } from "../../../../src/codex-runtime/llm-call-config.js";
import type { MatchEvalSuite } from "../harness/runner.js";

export type NextEvalVariantStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface NextEvalVariantRow {
  id: string;
  description: string;
  baseline: boolean;
  status: NextEvalVariantStatus;
  configuration: LlmConfigurationSet;
  eval: {
    trials: number;
    concurrency: number;
    suites: MatchEvalSuite[];
    caseIds?: string[];
    splits?: Array<"development" | "test">;
  };
  createdAt: string;
  updatedAt: string;
  lastRunId?: string;
  error?: string;
}

export interface VariantRunRow {
  id: string;
  variantId: string;
  configurationId: string;
  baseline: boolean;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  resolvedModel?: string;
  outputRoot?: string;
  summaryPath?: string;
  releaseGatePath?: string;
  releaseStatus?: "pass" | "fail" | "ineligible";
  releaseEligible?: boolean;
  comparisonToBaseline?: {
    baselineRunId: string;
    eligible: boolean;
    decision: "non_inferior" | "regression" | "inconclusive" | "ineligible";
    reportPath: string;
  };
  error?: string;
}

export interface EvalVariantTables {
  nextVariantsPath: string;
  variantRunsPath: string;
  sourcePlanPath: string;
}

export function variantTablePaths(cwd: string): EvalVariantTables {
  const tableRoot = path.join(cwd, ".agent-runtime", "match-requirements", "variants");
  return {
    nextVariantsPath: path.join(tableRoot, "next-eval-variants.json"),
    variantRunsPath: path.join(tableRoot, "variant-runs.json"),
    sourcePlanPath: path.join(
      cwd,
      "evals",
      "match-requirements",
      "config",
      "experiments.json",
    ),
  };
}

export async function readNextEvalVariants(cwd: string) {
  const paths = variantTablePaths(cwd);
  const runtimeRows = await readRows<NextEvalVariantRow>(paths.nextVariantsPath);
  if (runtimeRows.length) return runtimeRows;
  return readRows<NextEvalVariantRow>(paths.sourcePlanPath);
}

export async function writeNextEvalVariants(
  cwd: string,
  rows: NextEvalVariantRow[],
) {
  await writeRows(variantTablePaths(cwd).nextVariantsPath, rows);
}

export async function readVariantRuns(cwd: string) {
  return readRows<VariantRunRow>(variantTablePaths(cwd).variantRunsPath);
}

export async function writeVariantRuns(cwd: string, rows: VariantRunRow[]) {
  await writeRows(variantTablePaths(cwd).variantRunsPath, rows);
}

export function newVariantRun(row: NextEvalVariantRow): VariantRunRow {
  return {
    id: `variant-run-${randomUUID()}`,
    variantId: row.id,
    configurationId: row.configuration.id,
    baseline: row.baseline,
    status: "running",
    startedAt: new Date().toISOString(),
  };
}

async function readRows<T>(filePath: string): Promise<T[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!Array.isArray(parsed))
      throw new Error(`${filePath} must contain a JSON array`);
    return parsed as T[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeRows<T>(filePath: string, rows: T[]) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}
