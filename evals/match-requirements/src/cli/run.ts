import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexExecClient } from "../../../../src/codex-runtime/client.js";
import {
  runMatchRequirementsEval,
  type MatchEvalSuite,
} from "../harness/runner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.resolve(here, "../../../..");
const args = parseArgs(process.argv.slice(2));

const discoveryClient = new CodexExecClient(cwd);
const runtime = await discoveryClient.start();
await discoveryClient.close();
const defaultModels = [
  process.env.ROLEGAIN_FAST_MODEL || "gpt-5.4-mini",
  process.env.ROLEGAIN_MODEL || runtime.model || "gpt-5.4",
];
const models = unique(splitList(args.models) || defaultModels);
const trials = integerArg(args.trials, 3);
const concurrency = integerArg(args.concurrency, 6);
const cases = splitList(args.cases);
const suites = splitList(args.suites) as MatchEvalSuite[] | undefined;
const splits = splitList(args.split) as Array<"development" | "test"> | undefined;

process.stdout.write(
  `Running ${models.join(" vs ")} with ${trials} trial(s), concurrency ${concurrency}\n`,
);
const result = await runMatchRequirementsEval({
  cwd,
  models,
  trials,
  concurrency,
  caseIds: cases,
  suites,
  splits,
  includeRepairChallenges: !args["no-repair-challenges"],
  outputRoot: typeof args.output === "string" ? args.output : undefined,
});
process.stdout.write(`Eval artifacts: ${result.outputRoot}\n`);

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

function unique(values: string[]) {
  return [...new Set(values)];
}
