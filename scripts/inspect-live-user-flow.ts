import path from "node:path";
import {
  runLiveStage,
  type LiveStage,
} from "../src/backend/control-flow/live-runner.js";

const stage = (process.argv[2] || "full") as LiveStage;
const stages: LiveStage[] = [
  "evidence-reader",
  "evidence-synthesis",
  "evidence-verification",
  "evidence",
  "opportunity-research",
  "discovery",
  "matching",
  "inspection",
  "application-context",
  "application-draft",
  "application-verification",
  "application-repair",
  "application-refinement",
  "drafting",
  "full",
];
if (!stages.includes(stage))
  throw new Error(`Unknown live stage ${stage}. Use ${stages.join(", ")}.`);

const artifactRoot = path.resolve(
  option("--artifacts") || ".test-artifacts/live-user-flow",
);
const source = option("--input") || "mock";
const targetValue = option("--target");
const target = targetValue ? Number(targetValue) : undefined;

try {
  const result = await runLiveStage({
    stage,
    artifactRoot,
    source,
    target,
  });
  console.log(
    JSON.stringify(
      {
        stage,
        input: source,
        outputFile: result.outputFile,
        report: result.artifact.report,
        codexRuns: result.artifact.codexRuns,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        stage,
        input: source,
        failureFile: path.join(
          artifactRoot,
          stageDirectory(stage),
          "failure.json",
        ),
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function stageDirectory(value: LiveStage) {
  return {
    "evidence-reader": "01a-evidence-reader",
    "evidence-synthesis": "01b-evidence-synthesis",
    "evidence-verification": "01c-evidence-verification",
    evidence: "01-evidence",
    "opportunity-research": "03-match",
    discovery: "02-search",
    matching: "03-match/01-requirement-matching",
    inspection: "03-match/02-application-inspection",
    "application-context": "04-application-preparation/01-context",
    "application-draft": "04-application-preparation/02-draft",
    "application-verification": "04-application-preparation/03-verification",
    "application-repair": "04-application-preparation/04-repair",
    "application-refinement": "04-application-preparation/05-refinement",
    drafting: "04-application-preparation",
    full: "full-user-flow",
  }[value];
}
