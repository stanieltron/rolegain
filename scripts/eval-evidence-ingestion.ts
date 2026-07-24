import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CodexExecClient } from "../src/codex-runtime/client.js";
import { runEvidenceEvals } from "../src/01-evidence-ingestion/evals/runner.js";

const projectRoot = process.cwd();
const codex = new CodexExecClient(projectRoot);
try {
  const results = await runEvidenceEvals({
    codex,
    projectRoot,
    trials: Number.parseInt(process.env.ROLEGAIN_EVAL_TRIALS || "3", 10),
  });
  const directory = path.join(projectRoot, ".test-artifacts", "evidence-evals");
  await mkdir(directory, { recursive: true });
  const output = path.join(
    directory,
    `${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await writeFile(output, JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2));
  console.log(output);
  if (results.some((result) => {
    const value = result as { error?: string; grade?: { passed: boolean } };
    return value.error || value.grade?.passed === false;
  })) process.exitCode = 1;
} finally {
  await codex.close();
}
