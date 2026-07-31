import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyAndPersistEvidence } from "../../../src/01-evidence-ingestion/04-verification/index.js";
import { readCurrentEvidenceModel } from "../../../src/01-evidence-ingestion/04-verification/evidence-model.js";
import {
  auditProfileEvidence,
  repairDerivedNarrativeReadiness,
} from "../../../src/01-evidence-ingestion/04-verification/profile-evidence/index.js";
import type { EvidenceClaim } from "../../../src/contracts/evidence.js";
import {
  mockAnalysis,
  mockThreeChunkReading,
  mockWorkspaceWithCv,
} from "../../../src/01-evidence-ingestion/inspection/fixtures.js";

describe("Stage 04 — deterministic verification and persistence", () => {
  it("04.1 applies profile and source insights", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "inspection-verify-apply-"));
    const workspace = mockWorkspaceWithCv();
    const analysis = mockAnalysis(workspace);

    await verifyAndPersistEvidence({
      dataRoot,
      workspace,
      analysis,
      sourceIdsToAnalyze: new Set([workspace.sources[0].id]),
    });

    expect(workspace.profile).toMatchObject({
      headline: "Platform Engineer",
      summary: "Builds reliable TypeScript workflow systems.",
      skills: ["TypeScript", "workflow orchestration"],
    });
    expect(workspace.sources[0].insights).toHaveLength(3);
  });

  it("04.2 writes a layered knowledge base inside the immutable evidence run", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "inspection-verify-note-"));
    const workspace = mockWorkspaceWithCv();

    await verifyAndPersistEvidence({
      dataRoot,
      workspace,
      analysis: mockAnalysis(workspace),
      sourceIdsToAnalyze: new Set([workspace.sources[0].id]),
    });

    expect(workspace.sources[0].knowledgePath).toBeTruthy();
    const sourcePage = await readFile(
      path.join(dataRoot, workspace.sources[0].knowledgePath!),
      "utf8",
    );
    const currentRunDirectory = path.dirname(
      path.dirname(
        path.dirname(path.join(dataRoot, workspace.sources[0].knowledgePath!)),
      ),
    );
    const startHere = await readFile(
      path.join(currentRunDirectory, "knowledge", "START_HERE.md"),
      "utf8",
    );
    const index = JSON.parse(
      await readFile(
        path.join(currentRunDirectory, "knowledge", "index.json"),
        "utf8",
      ),
    ) as {
      entryPoint: string;
      pages: Array<{
        type: string;
        title: string;
        path: string;
        claimIds: string[];
      }>;
    };

    expect(sourcePage).toContain("# mira-cv.txt");
    expect(sourcePage).toContain("Deep reader analysis");
    expect(sourcePage).toContain("workflow orchestration");
    expect(sourcePage).toContain("../../claims.jsonl");
    expect(startHere).toContain("How to use this knowledge base");
    expect(startHere).toContain("Topic routes");
    expect(index.entryPoint).toBe("START_HERE.md");
    const topics = index.pages.filter((page) => page.type === "capability");
    expect(topics.length).toBeGreaterThan(0);
    expect(topics.every((page) => page.path.startsWith("topics/"))).toBe(true);
    expect(
      topics.every((page) => page.claimIds.length > 0),
    ).toBe(true);
  });

  it("04.3 accepts exact quotes and publishes a search-ready evidence run", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "inspection-verify-ready-"));
    const workspace = mockWorkspaceWithCv();
    const run = await verifyAndPersistEvidence({
      dataRoot,
      workspace,
      analysis: mockAnalysis(workspace),
      sourceIdsToAnalyze: new Set([workspace.sources[0].id]),
    });
    const model = await readCurrentEvidenceModel(dataRoot, workspace.candidateId);

    expect(run.manifest.readiness.readyForSearch).toBe(true);
    expect(model.claims).toHaveLength(3);
    expect(
      (model.claims as EvidenceClaim[]).every(
        (claim) => claim.supportStatus === "supported",
      ),
    ).toBe(true);
    expect(workspace.intelligence.evidenceRun?.id).toBe(
      run.manifest.evidenceRunId,
    );
    expect(workspace.sources[0]).toMatchObject({
      status: "ready",
      analysisRequired: false,
    });
  });

  it("04.4 rejects invented quotes and fails the readiness gate", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "inspection-verify-reject-"));
    const workspace = mockWorkspaceWithCv();
    const reading = mockThreeChunkReading(workspace);
    for (const claim of reading.sourceInsights[0].claims || [])
      claim.sourceEvidence[0].quote = "Invented quotation absent from the CV.";
    const analysis = mockAnalysis(workspace, reading);

    const run = await verifyAndPersistEvidence({
      dataRoot,
      workspace,
      analysis,
      sourceIdsToAnalyze: new Set([workspace.sources[0].id]),
    });

    expect(run.manifest.readiness.readyForSearch).toBe(false);
    expect(run.manifest.readiness.blockers).toContain(
      "No positive claim has an exact supported source reference",
    );
  });

  it("04.5 rejects a new profile value without exact field provenance", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "inspection-profile-evidence-"));
    const workspace = mockWorkspaceWithCv();
    const analysis = mockAnalysis(workspace);
    analysis.profile.location = "Invented City";
    analysis.profileEvidence = (analysis.profileEvidence || []).filter(
      (item) => item.field !== "location",
    );

    const run = await verifyAndPersistEvidence({
      dataRoot,
      workspace,
      analysis,
      sourceIdsToAnalyze: new Set([workspace.sources[0].id]),
    });

    expect(workspace.profile.location).toBe("");
    expect(run.manifest.readiness.readyForSearch).toBe(false);
    expect(run.manifest.readiness.blockers).toContain(
      'Profile field location="Invented City" has no exact source provenance',
    );
  });

  it("04.6 treats PDF hyphen line wrapping as layout, not changed evidence", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "inspection-pdf-wrap-"));
    const workspace = mockWorkspaceWithCv();
    workspace.sources[0].content += "\nBuilt backend-\nowned state controls.";
    const analysis = mockAnalysis(workspace);
    analysis.profile.skills.push("backend-owned state");
    analysis.profileEvidence?.push({
      field: "skills",
      value: "backend-owned state",
      sourceId: workspace.sources[0].id,
      locator: "lines 1-7",
      quote: "Built backend-owned state controls.",
    });

    const run = await verifyAndPersistEvidence({
      dataRoot,
      workspace,
      analysis,
      sourceIdsToAnalyze: new Set([workspace.sources[0].id]),
    });

    expect(run.manifest.readiness.blockers).not.toContain(
      'Profile field skills contains "backend-owned state" without exact source provenance',
    );
  });

  it("04.7 discards an unsupported generated summary without blocking search", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "inspection-derived-summary-"));
    const workspace = mockWorkspaceWithCv();
    const analysis = mockAnalysis(workspace);
    analysis.profile.summary =
      "Generated career narrative that is not a verbatim source fact.";
    analysis.profileEvidence = (analysis.profileEvidence || []).filter(
      (item) => item.field !== "summary",
    );

    const run = await verifyAndPersistEvidence({
      dataRoot,
      workspace,
      analysis,
      sourceIdsToAnalyze: new Set([workspace.sources[0].id]),
    });

    expect(workspace.profile.summary).toBe("");
    expect(run.manifest.readiness.readyForSearch).toBe(true);
    expect(run.manifest.readiness.blockers).toEqual([]);
  });

  it("04.8 repairs the obsolete derived-summary blocker in an existing run", () => {
    const repaired = repairDerivedNarrativeReadiness({
      readyForSearch: false,
      blockers: [
        'Profile field summary="Generated career narrative" has no exact source provenance',
      ],
      warnings: [],
      counts: {
        sources: 1,
        sourceBlocks: 1,
        claims: 57,
        supportedClaims: 57,
        capabilities: 26,
        roleFamilies: 6,
        unknowns: 0,
        contradictions: 0,
      },
    });

    expect(repaired.readyForSearch).toBe(true);
    expect(repaired.blockers).toEqual([]);
  });

  it("04.9 recovers selected skills from exact and bounded source passages", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "inspection-skill-recovery-"));
    const workspace = mockWorkspaceWithCv();
    workspace.sources[0].content +=
      "\nBuilt durable memory with vector and hybrid search for agent workflows.";
    const analysis = mockAnalysis(workspace);
    analysis.profile.skills.push("Durable memory", "Vector search");
    analysis.profileEvidence = (analysis.profileEvidence || []).filter(
      (item) =>
        item.value !== "Durable memory" && item.value !== "Vector search",
    );

    const run = await verifyAndPersistEvidence({
      dataRoot,
      workspace,
      analysis,
      sourceIdsToAnalyze: new Set([workspace.sources[0].id]),
    });

    expect(workspace.profile.skills).toEqual(
      expect.arrayContaining(["Durable memory", "Vector search"]),
    );
    expect(run.manifest.readiness.blockers).not.toContain(
      'Profile field skills contains "Durable memory" without exact source provenance',
    );
    expect(run.manifest.readiness.blockers).not.toContain(
      'Profile field skills contains "Vector search" without exact source provenance',
    );
  });

  it("04.10 still rejects a selected skill with no source support", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "inspection-unsupported-skill-"));
    const workspace = mockWorkspaceWithCv();
    const analysis = mockAnalysis(workspace);
    analysis.profile.skills.push("Kubernetes operations");
    analysis.profileEvidence = (analysis.profileEvidence || []).filter(
      (item) => item.value !== "Kubernetes operations",
    );

    const run = await verifyAndPersistEvidence({
      dataRoot,
      workspace,
      analysis,
      sourceIdsToAnalyze: new Set([workspace.sources[0].id]),
    });

    expect(workspace.profile.skills).not.toContain("Kubernetes operations");
    expect(run.manifest.readiness.blockers).toContain(
      'Profile field skills contains "Kubernetes operations" without exact source provenance',
    );
  });

  it("04.11 does not recover a short skill from inside an unrelated word", () => {
    const workspace = mockWorkspaceWithCv();
    workspace.sources[0].content =
      "Storage Administrator responsible for enterprise systems.";
    const proposed = {
      ...workspace.profile,
      skills: ["RAG"],
    };

    const audit = auditProfileEvidence({
      baseline: workspace.profile,
      proposed,
      sources: workspace.sources,
      evidence: [],
    });

    expect(audit.supports("skills", "RAG")).toBe(false);
    expect(audit.blockers).toContain(
      'Profile field skills contains "RAG" without exact source provenance',
    );
  });
});
