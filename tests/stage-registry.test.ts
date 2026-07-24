import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertStageRunArtifactKind,
  createStageRunArtifact,
  readJsonArtifact,
  writeJsonArtifact,
} from "../src/backend/control-flow/stage-artifacts.js";
import { runnableStageById, runnableStages } from "../src/backend/control-flow/stage-registry.js";
import { runEvidencePipelineStage } from "../src/backend/control-flow/evidence-pipeline-runner.js";

describe("pipeline program artifacts", () => {
  it("creates inspectable artifacts with a stable envelope", () => {
    const artifact = createStageRunArtifact({
      artifactKind: "rolegain.test.input",
      producer: {
        programId: "test.stage",
        pipeline: "01-evidence-ingestion",
        stage: "test-stage",
      },
      workspaceRef: { candidateId: "candidate-1", evidenceRunId: "run-1" },
      dataRoot: "data-root",
      data: { hello: "world" },
      diagnostics: { codexRuns: ["run-a"] },
    });

    expect(artifact.schemaVersion).toBe("1.0.0");
    expect(artifact.artifactKind).toBe("rolegain.test.input");
    expect(artifact.producer.programId).toBe("test.stage");
    expect(artifact.workspaceRef?.candidateId).toBe("candidate-1");
    expect(artifact.data).toEqual({ hello: "world" });
  });

  it("rejects the wrong artifact kind", () => {
    const artifact = createStageRunArtifact({
      artifactKind: "rolegain.left",
      producer: {
        programId: "test.stage",
        pipeline: "01-evidence-ingestion",
        stage: "test-stage",
      },
      data: {},
    });

    expect(() =>
      assertStageRunArtifactKind(artifact, "rolegain.right"),
    ).toThrow(/Expected rolegain.right artifact/);
  });

  it("round-trips JSON artifacts through disk", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pipeline-artifact-"));
    try {
      const file = path.join(directory, "nested", "artifact.json");
      await writeJsonArtifact(file, { artifactKind: "rolegain.test" });
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        artifactKind: "rolegain.test",
      });
      await expect(readJsonArtifact(file)).resolves.toEqual({
        artifactKind: "rolegain.test",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("acquires a supplemental source through the standalone evidence pipeline", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "evidence-pipeline-"));
    try {
      const inputFile = path.join(directory, "source.json");
      await writeJsonArtifact(inputFile, {
        source: {
          kind: "document",
          name: "project-note.txt",
          content: "Built and operated a TypeScript deployment service.",
        },
      });
      const result = await runEvidencePipelineStage({
        stage: "acquire",
        artifactRoot: path.join(directory, "artifacts"),
        source: inputFile,
      });
      expect(result.artifact.workspace?.sources).toEqual([
        expect.objectContaining({
          kind: "document",
          name: "project-note.txt",
          status: "processing",
        }),
      ]);
      expect(result.outputFile).toBe(
        path.join(directory, "artifacts", "01-acquisition", "output.json"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("pipeline program registry", () => {
  it("declares unique program ids and artifact kinds", () => {
    const ids = runnableStages.map((program) => program.id);
    expect(new Set(ids).size).toBe(ids.length);

    const inputKinds = runnableStages.map((program) => program.inputKind);
    const outputKinds = runnableStages.map((program) => program.outputKind);
    expect(new Set(inputKinds).size).toBe(inputKinds.length);
    expect(new Set(outputKinds).size).toBe(outputKinds.length);
  });

  it("keeps every program runnable and inspectable", () => {
    for (const program of runnableStages) {
      expect(program.title.trim()).not.toBe("");
      expect(program.purpose.trim()).not.toBe("");
      expect(program.reads.length).toBeGreaterThan(0);
      expect(program.writes.length).toBeGreaterThan(0);
      expect(program.inputKind).toMatch(/^rolegain\./);
      expect(program.outputKind).toMatch(/^rolegain\./);
      expect(program.runner.kind).toMatch(
        /^(evidence-inspection|evidence-pipeline|live-stage|vacancy-validation)$/,
      );
    }
  });

  it("exposes a standalone program for every numbered stage", async () => {
    const pipelineStages = {
      "01-evidence-ingestion": [
        "01-evidence-acquisition",
        "02-chunk-reader",
        "03-synthesis",
        "04-verification",
      ],
      "02-search": [
        "01-discovery",
        "03-vacancy-validation",
      ],
      "03-match": [
        "01-requirement-matching",
        "02-application-inspection",
      ],
      "04-application-preparation": [
        "01-context",
        "02-draft",
        "03-verification",
        "04-repair",
        "05-refinement",
      ],
    } as const;
    for (const [pipeline, stages] of Object.entries(pipelineStages)) {
      for (const stage of stages) {
        expect(
          runnableStages.some(
            (program) =>
              program.pipeline === pipeline && program.stage === stage,
          ),
          `${pipeline}/${stage} has no standalone program`,
        ).toBe(true);
      }
    }
  });

  it("exposes the pipeline programs needed to compose the main user flow", () => {
    expect(runnableStages.map((program) => program.id)).toEqual([
      "evidence.acquire-source",
      "evidence.prepare-chunks",
      "evidence.analyze-chunk",
      "evidence.verify-chunk-coverage",
      "evidence.repair-chunk",
      "evidence.apply-chunk-repair",
      "evidence.accept-chunk",
      "evidence.read-chunk",
      "evidence.read-chunks",
      "evidence.join-chunks",
      "evidence.synthesize",
      "evidence.verify-ledger",
      "evidence.ingest",
      "search.run",
      "search.discovery",
      "search.validate-vacancies",
      "match.requirements",
      "applications.inspect-form",
      "applications.build-context",
      "applications.draft",
      "applications.verify",
      "applications.repair",
      "applications.refine",
      "applications.prepare",
      "full.acceptance-flow",
    ]);
    expect(runnableStageById("search.validate-vacancies").stage).toBe(
      "03-vacancy-validation",
    );
  });
});
