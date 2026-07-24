import path from "node:path";
import { analyzeEvalFailures } from "../improvement/failure-analysis.js";

const [runRoot] = process.argv.slice(2);
if (!runRoot)
  throw new Error("Usage: tsx analyze-failures.ts RUN_DIRECTORY");

const analysis = await analyzeEvalFailures(path.resolve(runRoot));
process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
