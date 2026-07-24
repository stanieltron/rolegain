import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  runInspectionPipeline,
  runInspectionStage,
  type StageArtifact,
} from "../../../src/01-evidence-ingestion/inspection/serial-runner.js";

describe("serial evidence-ingestion inspection", () => {
  it("runs acquisition → reader → synthesis → verification → search handoff", async () => {
    const artifactRoot = await mkdtemp(
      path.join(tmpdir(), "inspection-serial-"),
    );
    const outputs = await runInspectionPipeline(artifactRoot);

    expect(outputs.map((output) => output.stage)).toEqual([
      "acquisition",
      "reader",
      "synthesis",
      "verification",
      "search-handoff",
    ]);
    for (const output of outputs)
      await expect(access(output.outputFile)).resolves.toBeUndefined();
    const final = JSON.parse(
      await readFile(outputs.at(-1)!.outputFile, "utf8"),
    ) as StageArtifact;
    expect(final.workspace.intelligence.evidenceRun?.readyForSearch).toBe(true);
    expect(final.searchInput).toBeTruthy();
  });

  it("runs a stage independently with its checked mock input", async () => {
    const artifactRoot = await mkdtemp(
      path.join(tmpdir(), "inspection-independent-"),
    );
    const result = await runInspectionStage("synthesis", {
      artifactRoot,
      input: "mock",
    });
    expect(result.artifact.reading?.totalChunks).toBe(3);
    expect(result.artifact.analysis?.profile.headline).toBe("Platform Engineer");
  });

  it("accepts the explicit JSON output path of the previous stage", async () => {
    const artifactRoot = await mkdtemp(
      path.join(tmpdir(), "inspection-path-input-"),
    );
    const acquisition = await runInspectionStage("acquisition", {
      artifactRoot,
      input: "mock",
    });
    const reader = await runInspectionStage("reader", {
      artifactRoot,
      input: acquisition.outputFile,
    });
    expect(reader.artifact.workspace.sources[0].id).toBe(
      acquisition.artifact.workspace.sources[0].id,
    );
    expect(reader.artifact.reading?.totalChunks).toBe(1);
  });
});
