import path from "node:path";
import { fileURLToPath } from "node:url";
import { runLlmCallEval } from "../runner.js";
import type { LlmEvalSuite } from "../cases.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.resolve(here, "../../../..");
const args = parseArgs(process.argv.slice(2));

const result = await runLlmCallEval({
  cwd,
  live: Boolean(args.live),
  model: typeof args.model === "string" ? args.model : undefined,
  concurrency: integerArg(args.concurrency, 4),
  suites: splitList(args.suites) as LlmEvalSuite[] | undefined,
  caseIds: splitList(args.cases),
  outputRoot: typeof args.output === "string" ? args.output : undefined,
});

process.stdout.write(
  `LLM eval artifacts: ${result.outputRoot}\n` +
    `Cases: ${result.summary.passed}/${result.summary.total} passed\n` +
    `Flows: ${result.summary.flowPassed}/${result.summary.flowTotal} passed\n`,
);

if (result.summary.failed || result.summary.flowFailed) process.exitCode = 1;

function parseArgs(values: string[]) {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const [rawKey, inline] = value.slice(2).split("=", 2);
    if (inline !== undefined) parsed[rawKey] = inline;
    else if (values[index + 1] && !values[index + 1].startsWith("--"))
      parsed[rawKey] = values[++index];
    else parsed[rawKey] = true;
  }
  return parsed;
}

function splitList(value: string | boolean | undefined) {
  if (typeof value !== "string") return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function integerArg(value: string | boolean | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value))
    throw new Error(`Expected a positive integer, received ${String(value)}`);
  const parsed = Number(value);
  if (parsed < 1) throw new Error(`Expected a positive integer, received ${value}`);
  return parsed;
}
