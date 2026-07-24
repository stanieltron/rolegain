import path from "node:path";
import { createStageRunArtifact, readJsonArtifact, writeJsonArtifact } from "../src/backend/control-flow/stage-artifacts.js";
import {
  runnableStageById,
  runnableStages,
  type RunnableStage,
} from "../src/backend/control-flow/stage-registry.js";
import { createRolegainDependencies } from "../src/backend/control-flow/composition.js";
import type { JobOpportunity, JobSearchWorkspace } from "../src/contracts/job-search.js";
import { runInspectionStage } from "../src/01-evidence-ingestion/inspection/serial-runner.js";
import { runLiveStage, type LiveArtifact } from "../src/backend/control-flow/live-runner.js";
import { runEvidencePipelineStage } from "../src/backend/control-flow/evidence-pipeline-runner.js";

type VacancyValidationInputArtifact = Partial<LiveArtifact> & {
  data?: {
    workspace?: JobSearchWorkspace;
    opportunities?: JobOpportunity[];
  };
};

const command = process.argv[2] || "list";

if (command === "list") {
  console.log(
    JSON.stringify(
      {
        stages: runnableStages.map((program) => ({
          id: program.id,
          title: program.title,
          pipeline: program.pipeline,
          stage: program.stage,
          inputKind: program.inputKind,
          outputKind: program.outputKind,
          runner: program.runner,
        })),
      },
      null,
      2,
    ),
  );
} else {
  const program = runnableStageById(command);
  const artifactRoot = path.resolve(option("--artifacts") || ".test-artifacts/stage-registry");
  const input = option("--input") || "mock";
  const targetValue = option("--target");
  const target = targetValue ? Number(targetValue) : undefined;

  if (program.runner.kind === "live-stage") {
    const result = await runLiveStage({
      stage: program.runner.stage,
      artifactRoot,
      source: input,
      target,
    });
    const outputFile = await publishStageOutput(program, result.outputFile, {
      codexRuns: result.artifact.codexRuns,
    });
    printResult({
      programId: program.id,
      input,
      inputKind: program.inputKind,
      outputKind: program.outputKind,
      outputFile,
      report: result.artifact.report,
      codexRuns: result.artifact.codexRuns,
    });
  } else if (program.runner.kind === "evidence-pipeline") {
    const result = await runEvidencePipelineStage({
      stage: program.runner.stage,
      artifactRoot,
      source: input,
      target,
    });
    const outputFile = await publishStageOutput(program, result.outputFile, {
      codexRuns: result.artifact.codexRuns,
    });
    printResult({
      programId: program.id,
      input,
      inputKind: program.inputKind,
      outputKind: program.outputKind,
      outputFile,
      report: result.artifact.report,
      codexRuns: result.artifact.codexRuns,
    });
  } else if (program.runner.kind === "evidence-inspection") {
    const result = await runInspectionStage(program.runner.stage, {
      artifactRoot,
      input,
    });
    const outputFile = await publishStageOutput(program, result.outputFile);
    printResult({
      programId: program.id,
      input,
      inputKind: program.inputKind,
      outputKind: program.outputKind,
      outputFile,
    });
  } else {
    const result = await runVacancyValidationStage({
      artifactRoot,
      input,
      programId: program.id,
      outputKind: program.outputKind,
    });
    const outputFile = await publishStageOutput(program, result.outputFile, {
      codexRuns: result.codexRuns,
    });
    printResult({
      programId: program.id,
      input,
      inputKind: program.inputKind,
      outputKind: program.outputKind,
      outputFile,
      report: result.report,
      codexRuns: result.codexRuns,
    });
  }
}

async function publishStageOutput(
  program: RunnableStage,
  checkpointFile: string,
  diagnostics?: { codexRuns?: string[]; warnings?: string[] },
) {
  const data = await readJsonArtifact<Record<string, unknown>>(checkpointFile);
  if (data.artifactKind === program.outputKind) return checkpointFile;
  const workspace = data.workspace as JobSearchWorkspace | undefined;
  const artifact = createStageRunArtifact({
    artifactKind: program.outputKind,
    producer: {
      programId: program.id,
      pipeline: program.pipeline,
      stage: program.stage,
    },
    dataRoot: typeof data.dataRoot === "string" ? data.dataRoot : undefined,
    workspaceRef: workspace
      ? {
          candidateId: workspace.candidateId,
          evidenceRunId: workspace.intelligence.evidenceRun?.id,
        }
      : undefined,
    data,
    diagnostics,
  });
  return writeJsonArtifact(
    path.join(path.dirname(checkpointFile), "stage-output.json"),
    artifact,
  );
}

async function runVacancyValidationStage(input: {
  artifactRoot: string;
  input: string;
  programId: string;
  outputKind: string;
}) {
  const stageDirectory = path.join(input.artifactRoot, "search-validate-vacancies");
  const resolved = await resolveVacancyValidationInput(input.artifactRoot, input.input);
  await writeJsonArtifact(path.join(stageDirectory, "input.json"), resolved);
  const dependencies = await createRolegainDependencies({
    dataRoot: resolved.dataRoot,
  });
  const runsBefore = await runtimeRuns(dependencies.root);
  try {
    const result = await dependencies.researcher.revalidate(
      resolved.workspace,
      resolved.opportunities,
    );
    const codexRuns = difference(await runtimeRuns(dependencies.root), runsBefore);
    const artifact = createStageRunArtifact({
      artifactKind: input.outputKind,
      producer: {
        programId: input.programId,
        pipeline: "02-search",
        stage: "03-vacancy-validation",
      },
      dataRoot: resolved.dataRoot,
      workspaceRef: {
        candidateId: resolved.workspace.candidateId,
        evidenceRunId: resolved.workspace.intelligence.evidenceRun?.id,
      },
      data: {
        workspace: resolved.workspace,
        opportunities: result.opportunities,
        failures: result.failures,
      },
      diagnostics: { codexRuns },
    });
    const outputFile = await writeJsonArtifact(
      path.join(stageDirectory, "output.json"),
      artifact,
    );
    return {
      outputFile,
      codexRuns,
      report: {
        inputJobs: resolved.opportunities.length,
        validated: result.opportunities.length,
        failures: result.failures.length,
      },
    };
  } finally {
    await dependencies.close();
  }
}

async function resolveVacancyValidationInput(
  artifactRoot: string,
  source: string,
): Promise<{
  dataRoot: string;
  workspace: JobSearchWorkspace;
  opportunities: JobOpportunity[];
}> {
  const artifact =
    source === "previous"
      ? await readJsonArtifact<VacancyValidationInputArtifact>(
          path.join(
            artifactRoot,
            "02-search",
            "output.json",
          ),
        )
      : source === "mock"
        ? undefined
        : await readJsonArtifact<VacancyValidationInputArtifact>(
            path.resolve(source),
          );
  if (!artifact)
    throw new Error(
      "search.validate-vacancies needs --input previous or a JSON artifact containing workspace and opportunities",
    );
  const workspace = artifact.workspace ?? artifact.data?.workspace;
  const opportunities =
    artifact.opportunities ??
    artifact.research?.opportunities ??
    artifact.data?.opportunities ??
    [];
  const dataRoot = artifact.dataRoot;
  if (!workspace) throw new Error("Vacancy validation input has no workspace");
  if (!dataRoot) throw new Error("Vacancy validation input has no dataRoot");
  if (opportunities.length === 0)
    throw new Error("Vacancy validation input has no opportunities");
  return { dataRoot, workspace, opportunities };
}

async function runtimeRuns(projectRoot: string) {
  const { readdir } = await import("node:fs/promises");
  return readdir(path.join(projectRoot, ".agent-runtime", "runs")).catch(() => []);
}

function difference(after: string[], before: string[]) {
  const existing = new Set(before);
  return after.filter((item) => !existing.has(item)).sort();
}

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function printResult(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}
