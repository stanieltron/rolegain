import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { synthesizeCandidateEvidence } from "../../../src/01-evidence-ingestion/03-synthesis/index.js";
import {
  mockSynthesis,
  mockThreeChunkReading,
  mockWorkspaceWithCv,
} from "../../../src/01-evidence-ingestion/inspection/fixtures.js";
import { mockCodex } from "../../../src/01-evidence-ingestion/inspection/mock-codex.js";

describe("Stage 03 — synthesis", () => {
  it("03.1 reduces three mock chunks with exactly one synthesis LLM call", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "inspection-synthesis-"));
    const workspace = mockWorkspaceWithCv();
    const reading = mockThreeChunkReading(workspace);
    const codex = mockCodex([mockSynthesis(workspace)]);
    const progress: unknown[] = [];

    const output = await synthesizeCandidateEvidence({
      codex: codex.client,
      cwd,
      workspace,
      model: "mock-model",
      reading,
      onProgress: (event) => void progress.push(event),
    });

    expect(reading.sourceNotes[0].chunks).toHaveLength(3);
    expect(codex.calls).toHaveLength(1);
    expect(codex.calls[0].thread.callId).toBe("evidence.synthesis");
    expect(codex.calls[0].turn.prompt).toContain("workflow orchestration");
    expect(codex.calls[0].turn.prompt).toContain("operational improvement");
    expect(output.profile.headline).toBe("Platform Engineer");
    expect(output.roleFamilies?.[0].canonicalTitle).toBe("Platform Engineer");
    expect(output.searchVocabulary?.titleAliases).toEqual([
      "Platform Engineer",
      "Backend Platform Engineer",
    ]);
    expect(output.searchVocabulary?.problemPhrases).toEqual([
      "workflow reliability",
    ]);
    expect(output.searchVocabulary?.toolsMethodsStandards).toEqual([
      "TypeScript",
      "idempotent checkpoints",
    ]);
    expect(progress).toEqual([
      { stage: "synthesizing", completed: 3, total: 3 },
    ]);
  });

  it("03.2 preserves reader-owned claims instead of accepting rewritten synthesis claims", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "inspection-synthesis-claims-"));
    const workspace = mockWorkspaceWithCv();
    const reading = mockThreeChunkReading(workspace);
    const codex = mockCodex([mockSynthesis(workspace)]);

    const output = await synthesizeCandidateEvidence({
      codex: codex.client,
      cwd,
      workspace,
      model: "mock-model",
      reading,
    });

    expect(output.sourceInsights).toBe(reading.sourceInsights);
    expect(output.sourceInsights[0].claims).toHaveLength(3);
    expect(output.sourceInsights[0].claims?.map((claim) => claim.capability)).toEqual([
      "workflow orchestration",
      "reliability engineering",
      "operational improvement",
    ]);
  });

  it("03.3 restores reader provenance for an exactly selected profile value", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "inspection-synthesis-evidence-"));
    const workspace = mockWorkspaceWithCv();
    const reading = mockThreeChunkReading(workspace);
    const synthesis = mockSynthesis(workspace);
    synthesis.profile.summary = "Builds reliable workflow systems.";
    const codex = mockCodex([synthesis]);

    const output = await synthesizeCandidateEvidence({
      codex: codex.client,
      cwd,
      workspace,
      model: "mock-model",
      reading,
    });

    expect(output.profileEvidence).toContainEqual(
      expect.objectContaining({
        field: "summary",
        value: "Builds reliable workflow systems.",
      }),
    );
  });

  it("03.4 uses the lean synthesis contract only for v2", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "inspection-synthesis-v2-"));
    const workspace = mockWorkspaceWithCv();
    const reading = mockThreeChunkReading(workspace);
    const rich = mockSynthesis(workspace);
    const { profileEvidence: _profileEvidence, ...withoutEvidence } = rich;
    const {
      titleAliases: _titleAliases,
      problemPhrases: _problemPhrases,
      ...semanticVocabulary
    } = rich.searchVocabulary!;
    const codex = mockCodex([
      { ...withoutEvidence, searchVocabulary: semanticVocabulary },
    ]);

    const output = await synthesizeCandidateEvidence({
      codex: codex.client,
      cwd,
      workspace,
      model: "mock-model",
      reading,
      version: "v2",
    });

    const schema = codex.calls[0].turn.outputSchema as {
      required: string[];
      properties: { searchVocabulary: { required: string[] } };
    };
    expect(schema.required).not.toContain("profileEvidence");
    expect(schema.properties.searchVocabulary.required).not.toContain(
      "titleAliases",
    );
    expect(schema.properties.searchVocabulary.required).not.toContain(
      "problemPhrases",
    );
    expect(output.profileEvidence?.length).toBeGreaterThan(0);
    expect(output.searchVocabulary?.titleAliases).toEqual([
      "Platform Engineer",
      "Backend Platform Engineer",
    ]);
  });
});
