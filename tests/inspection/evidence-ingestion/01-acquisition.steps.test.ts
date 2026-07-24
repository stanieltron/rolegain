import { createHash } from "node:crypto";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireEvidence } from "../../../src/01-evidence-ingestion/01-evidence-acquisition/flow.js";
import { addSupplementalEvidence } from "../../../src/01-evidence-ingestion/01-evidence-acquisition/additional-evidence/add-evidence.js";
import {
  stageProfileEvidenceSources,
  synchronizeProfileEvidenceSources,
} from "../../../src/01-evidence-ingestion/01-evidence-acquisition/additional-evidence/profile-links.js";
import { mockWorkspace, MOCK_CV_TEXT } from "../../../src/01-evidence-ingestion/inspection/fixtures.js";

describe("Stage 01 — evidence acquisition", () => {
  it("01a.1 reads, stores, installs, and invalidates one mock CV", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "inspection-cv-"));
    const workspace = mockWorkspace();

    await acquireEvidence({
      dataRoot,
      workspace,
      source: { kind: "cv", name: "mira-cv.txt", content: MOCK_CV_TEXT },
      analyzeWithLlm: true,
    });

    const cv = workspace.sources[0];
    expect(cv).toMatchObject({
      kind: "cv",
      name: "mira-cv.txt",
      content: MOCK_CV_TEXT,
      status: "processing",
      analysisRequired: true,
    });
    expect(cv).not.toHaveProperty("contentHash");
    expect(workspace.finalCv).toBe(MOCK_CV_TEXT);
    expect(workspace.profile).toMatchObject({
      name: "",
      email: "mira@example.test",
    });
    expect(workspace.intelligence.status).toBe("analyzing");
    await expect(
      access(
        path.join(
          dataRoot,
          "job-search",
          "files",
          workspace.candidateId,
          `${cv.id}.txt`,
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("01a.2 replaces the previous CV but preserves supplemental evidence", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "inspection-replace-"));
    const workspace = mockWorkspace();
    await acquireEvidence({
      dataRoot,
      workspace,
      source: { kind: "cv", name: "old.txt", content: "Old Candidate\nold@example.test\nBuilt old systems." },
      analyzeWithLlm: true,
    });
    await addSupplementalEvidence({
      dataRoot,
      workspace,
      source: {
        kind: "document",
        name: "project.txt",
        content: "Designed an independent project control plane.",
      },
      analyzeWithLlm: true,
    });
    const supplementalId = workspace.sources.find((source) => source.kind !== "cv")!.id;

    await acquireEvidence({
      dataRoot,
      workspace,
      source: { kind: "cv", name: "new.txt", content: MOCK_CV_TEXT },
      analyzeWithLlm: true,
    });

    expect(workspace.sources.filter((source) => source.kind === "cv")).toHaveLength(1);
    expect(workspace.sources.find((source) => source.kind === "cv")?.name).toBe("new.txt");
    expect(workspace.sources.some((source) => source.id === supplementalId)).toBe(true);
  });

  it("01b.1 normalizes and hashes supplemental text once", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "inspection-hash-"));
    const workspace = mockWorkspace();
    const normalized = "Built a reliable platform.\n\nLed production operations.";
    await addSupplementalEvidence({
      dataRoot,
      workspace,
      source: {
        kind: "document",
        name: "project.txt",
        content: "Built   a reliable platform.\n\n\nLed production operations.",
      },
      analyzeWithLlm: true,
    });
    expect(workspace.sources[0].content).toBe(normalized);
    expect(workspace.sources[0].contentHash).toBe(
      createHash("sha256").update(normalized).digest("hex"),
    );
  });

  it("01b.2 skips a renamed duplicate and keeps one source", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "inspection-dedupe-"));
    const workspace = mockWorkspace();
    const first = await addSupplementalEvidence({
      dataRoot,
      workspace,
      source: {
        kind: "document",
        name: "first.txt",
        content: "Implemented a bounded recovery workflow.",
      },
      analyzeWithLlm: true,
    });
    const duplicate = await addSupplementalEvidence({
      dataRoot,
      workspace,
      source: {
        kind: "document",
        name: "renamed.txt",
        content: "Implemented   a bounded recovery workflow.",
      },
      analyzeWithLlm: true,
    });

    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.source.id).toBe(first.source.id);
    expect(workspace.sources).toHaveLength(1);
  });

  it("01b.3 stages and reads a profile link through the same supplemental path", async () => {
    const workspace = mockWorkspace();
    workspace.profile.website = "https://mira.example";
    expect(stageProfileEvidenceSources(workspace, ["website"])).toEqual({
      changed: true,
      needsFetch: true,
    });

    const synchronized = await synchronizeProfileEvidenceSources({
      workspace,
      reloadWorkspace: async () => workspace,
      analyzeWithLlm: true,
      signal: new AbortController().signal,
      reader: async (source) => ({
        kind: source.kind,
        name: source.name,
        url: source.url,
        content: "Portfolio: implemented a durable workflow platform.",
        contentHash: createHash("sha256")
          .update("Portfolio: implemented a durable workflow platform.")
          .digest("hex"),
      }),
    });

    expect(synchronized.successes).toBe(1);
    expect(synchronized.workspace.sources[0]).toMatchObject({
      profileField: "website",
      status: "processing",
      analysisRequired: true,
      content: "Portfolio: implemented a durable workflow platform.",
    });
  });
});
