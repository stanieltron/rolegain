import path from "node:path";
import {
  runInspectionPipeline,
  runInspectionStage,
  type InspectionStage,
} from "../src/01-evidence-ingestion/inspection/serial-runner.js";

const command = process.argv[2] || "all";
const input = option("--input") || "mock";
const artifactRoot = path.resolve(
  option("--artifacts") || ".test-artifacts/evidence-ingestion",
);

if (command === "all") {
  const outputs = await runInspectionPipeline(artifactRoot);
  console.log(JSON.stringify({ artifactRoot, outputs }, null, 2));
} else {
  const stages: InspectionStage[] = [
    "acquisition",
    "reader",
    "synthesis",
    "verification",
    "search-handoff",
  ];
  if (!stages.includes(command as InspectionStage))
    throw new Error(`Unknown stage ${command}. Use all or ${stages.join(", ")}.`);
  const result = await runInspectionStage(command as InspectionStage, {
    artifactRoot,
    input,
  });
  console.log(
    JSON.stringify(
      { stage: command, input, outputFile: result.outputFile },
      null,
      2,
    ),
  );
}

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
