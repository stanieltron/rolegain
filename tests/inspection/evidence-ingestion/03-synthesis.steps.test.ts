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
});
