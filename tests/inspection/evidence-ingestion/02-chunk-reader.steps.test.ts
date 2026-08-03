import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  chunkSourceForAnalysis,
  chunkSourceWithLocators,
  joinCandidateSourceChunkReadings,
  normalizeChunkNotes,
  prepareCandidateSourceChunks,
  readCandidateSourceChunks,
} from "../../../src/01-evidence-ingestion/v1/02-chunk-reader/index.js";
import {
  analyzeChunkOnce,
  readAndVerifyChunk,
  verifyChunkCoverageOnce,
} from "../../../src/01-evidence-ingestion/v1/02-chunk-reader/recovery/run-reader-with-coverage.js";
import { applyChunkRepairPatch } from "../../../src/01-evidence-ingestion/v1/02-chunk-reader/repair/apply-chunk-repair.js";
import {
  mockChunkNotes,
  mockCoverage,
  mockWorkspaceWithCv,
} from "../../../src/01-evidence-ingestion/inspection/fixtures.js";
import { mockCodex } from "../../../src/01-evidence-ingestion/inspection/mock-codex.js";

describe("Stage 02 — chunk reader", () => {
  it("02.0 exposes prepare, one raw analysis, raw coverage, transaction, and join boundaries", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "inspection-pipeline-"));
    const workspace = mockWorkspaceWithCv();
    const prepared = prepareCandidateSourceChunks(workspace);
    expect(prepared.jobs).toHaveLength(1);

    const analysisCodex = mockCodex([mockChunkNotes(workspace.sources[0].id)]);
    const analysis = await analyzeChunkOnce({
      codex: analysisCodex.client,
      cwd,
      model: "mock-model",
      job: prepared.jobs[0],
      normalize: normalizeChunkNotes,
    });
    expect(analysisCodex.calls[0].thread.callId).toBe("evidence.chunk-analysis");

    const coverageCodex = mockCodex([mockCoverage()]);
    const coverage = await verifyChunkCoverageOnce({
      codex: coverageCodex.client,
      cwd,
      model: "mock-model",
      job: prepared.jobs[0],
      extraction: analysis.notes,
    });
    expect(coverageCodex.calls[0].thread.callId).toBe("evidence.chunk-coverage");
    expect(coverage.decision.passed).toBe(true);

    const transactionCodex = mockCodex([
      mockChunkNotes(workspace.sources[0].id),
      mockCoverage(),
    ]);
    const chunkResult = await readAndVerifyChunk({
      codex: transactionCodex.client,
      cwd,
      model: "mock-model",
      job: prepared.jobs[0],
      normalize: normalizeChunkNotes,
    });
    expect(chunkResult).toMatchObject({
      attempts: 1,
      readerThreadIds: ["mock-thread-1"],
      coverageThreadIds: ["mock-thread-2"],
      coverage: { passed: true },
    });

    const reading = joinCandidateSourceChunkReadings(workspace, prepared, [
      chunkResult,
    ]);
    expect(reading.totalChunks).toBe(1);
    expect(reading.sourceInsights[0].claims).toHaveLength(1);
  });

  it("02.1 makes one locator chunk for one small CV", () => {
    const chunks = chunkSourceWithLocators("line one\nline two\nline three");
    expect(chunks).toEqual([
      { content: "line one\nline two\nline three", locator: "lines 1-3" },
    ]);
  });

  it("02.1a packs small website pages and preserves context for oversized pages", () => {
    const firstPage = [
      "Page: https://example.test/project-a",
      "Project A - built by the candidate",
      "I designed and implemented this system.",
      "A".repeat(19_000),
    ].join("\n");
    const secondPage = [
      "Page: https://example.test/project-b",
      "Project B",
      "I operated this service.",
    ].join("\n");
    const chunks = chunkSourceForAnalysis({
      kind: "webpage",
      content: `${firstPage}\n\n${secondPage}`,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("Page: https://example.test/project-a");
    expect(chunks[0].content).toContain(
      "Page: https://example.test/project-b",
    );

    const oversized = chunkSourceForAnalysis({
      kind: "webpage",
      content: `${firstPage}${"A".repeat(35_000)}\n\n${secondPage}`,
    });
    expect(oversized.length).toBeGreaterThan(1);
    expect(oversized[1].content).toContain(
      "[Repeated page context for attribution and orientation]",
    );
    expect(oversized[1].content).toContain(
      "I designed and implemented this system.",
    );
    expect(oversized.at(-1)?.content).toContain(
      "Page: https://example.test/project-b",
    );
  });

  it("02.1b does not turn non-representable warning context into a blocker", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "inspection-warning-"));
    const workspace = mockWorkspaceWithCv();
    const prepared = prepareCandidateSourceChunks(workspace);
    const codex = mockCodex([
      mockCoverage({
        complete: false,
        missingEvidence: [
          {
            findingId: "telegram-warning",
            operation: "add",
            target: "detailedNotes",
            field: "telegram",
            severity: "warning",
            quote: "Mira Example",
            reason: "Unsupported contact context is non-blocking.",
            category: "other",
          },
        ],
      }),
    ]);
    const coverage = await verifyChunkCoverageOnce({
      codex: codex.client,
      cwd,
      model: "mock-model",
      job: prepared.jobs[0],
      extraction: mockChunkNotes(workspace.sources[0].id),
    });
    expect(coverage.decision).toMatchObject({
      passed: true,
      missingEvidence: [],
      feedback: [],
    });
  });

  it("02.1b applies a newly aligned profile field to a legacy extraction", () => {
    const workspace = mockWorkspaceWithCv();
    const job = prepareCandidateSourceChunks(workspace).jobs[0];
    const current = mockChunkNotes(workspace.sources[0].id);
    delete (current.profileFacts as Partial<typeof current.profileFacts>).website;
    const additions = mockChunkNotes(workspace.sources[0].id);
    additions.profileFacts = {
      name: "",
      email: "",
      phone: "",
      linkedin: "",
      github: "",
      website: "example.test",
      location: "",
      headline: "",
      summary: "",
      skills: [],
      languages: [],
    };
    additions.profileEvidence = [
      {
        field: "website",
        value: "example.test",
        sourceId: job.source.id,
        locator: job.locator,
        quote: "Mira Example",
      },
    ];
    additions.insights = [];
    additions.detailedNotes = "";
    additions.claims = [];
    additions.unknowns = [];
    additions.prohibitedInferences = [];

    const merged = applyChunkRepairPatch({
      current,
      patch: { additions, removals: [], resolutions: [] },
      job,
      normalize: normalizeChunkNotes,
    });

    expect(merged.profileFacts.website).toBe("example.test");
    expect(merged.claims).toHaveLength(current.claims.length);
  });

  it("02.2 makes three bounded chunks and keeps the final line", () => {
    const content = Array.from(
      { length: 15 },
      (_, index) => `line-${index + 1}: ${"evidence ".repeat(5)}`,
    ).join("\n");
    const chunks = chunkSourceWithLocators(content, 350, 40);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.locator)).toEqual([
      expect.stringMatching(/^lines 1-/),
      expect.stringMatching(/^lines \d+-/),
      expect.stringMatching(/-15$/),
    ]);
    expect(chunks.at(-1)?.content).toContain("line-15");
  });

  it("02.3 sends one mock chunk to one reader LLM and owns its locator", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "inspection-reader-"));
    const workspace = mockWorkspaceWithCv();
    const notes = mockChunkNotes(workspace.sources[0].id);
    notes.claims[0].sourceEvidence[0] = {
      sourceId: "model-invented-source",
      locator: "model-invented-locator",
      quote: notes.claims[0].sourceEvidence[0].quote,
    };
    const codex = mockCodex([notes, mockCoverage()]);
    const progress: unknown[] = [];

    const output = await readCandidateSourceChunks({
      codex: codex.client,
      cwd,
      workspace,
      model: "mock-model",
      onProgress: (event) => void progress.push(event),
    });

    expect(output.totalChunks).toBe(1);
    expect(codex.calls).toHaveLength(2);
    expect(codex.calls[0].thread.callId).toBe("evidence.chunk-analysis");
    expect(codex.calls[1].thread.callId).toBe("evidence.chunk-coverage");
    expect(codex.calls[0].turn.prompt).toContain("chunk 1 of 1");
    expect(output.sourceInsights[0].claims?.[0].sourceEvidence[0]).toMatchObject({
      sourceId: workspace.sources[0].id,
      locator: "lines 1-5",
    });
    expect(progress).toEqual([
      expect.objectContaining({ stage: "reading", completed: 0, total: 1 }),
      expect.objectContaining({ stage: "reading", completed: 1, total: 1 }),
    ]);
  });

  it("02.4 consolidates repeated insight data without duplicating it", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "inspection-reader-join-"));
    const workspace = mockWorkspaceWithCv();
    workspace.sources[0].content = Array.from(
      { length: 900 },
      (_, index) => `Evidence ${index}: implemented durable workflow recovery for failed jobs.`,
    ).join("\n");
    const chunkCount = chunkSourceWithLocators(workspace.sources[0].content).length;
    expect(chunkCount).toBeGreaterThan(1);
    const outputs = Array.from({ length: chunkCount }, () =>
      mockChunkNotes(workspace.sources[0].id),
    );
    const codex = mockCodex(
      outputs.flatMap((output) => [output, mockCoverage()]),
    );

    const output = await readCandidateSourceChunks({
      codex: codex.client,
      cwd,
      workspace,
      model: "mock-model",
    });

    expect(codex.calls).toHaveLength(chunkCount * 2);
    expect(output.sourceNotes[0].chunks).toHaveLength(chunkCount);
    expect(output.sourceInsights[0].insights).toHaveLength(1);
    expect(output.sourceInsights[0].claims).toHaveLength(chunkCount);
  });

  it("02.4a rebases cached webpage evidence to the current source id", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "inspection-reader-cache-"));
    const firstWorkspace = mockWorkspaceWithCv();
    firstWorkspace.sources[0] = {
      ...firstWorkspace.sources[0],
      id: "first-source-id",
      kind: "webpage",
      url: "https://example.test/profile",
      contentHash: "stable-page-content",
    };
    const firstCodex = mockCodex([
      mockChunkNotes(firstWorkspace.sources[0].id),
      mockCoverage(),
    ]);
    await readCandidateSourceChunks({
      codex: firstCodex.client,
      cwd,
      workspace: firstWorkspace,
      model: "mock-model",
    });

    const resetWorkspace = structuredClone(firstWorkspace);
    resetWorkspace.sources[0].id = "reset-source-id";
    const cachedCodex = mockCodex([]);
    const cached = await readCandidateSourceChunks({
      codex: cachedCodex.client,
      cwd,
      workspace: resetWorkspace,
      model: "mock-model",
    });

    expect(cachedCodex.calls).toHaveLength(0);
    expect(
      cached.sourceInsights[0].claims?.[0].sourceEvidence[0].sourceId,
    ).toBe("reset-source-id");
    expect(cached.sourceNotes[0].chunks[0].profileEvidence[0].sourceId).toBe(
      "reset-source-id",
    );
  });

  it("02.5 patches only the failed chunk and verifies the merged extraction", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "inspection-reader-retry-"));
    const workspace = mockWorkspaceWithCv();
    const first = mockChunkNotes(workspace.sources[0].id);
    first.claims = [];
    const repaired = mockChunkNotes(workspace.sources[0].id);
    repaired.profileFacts = {
      name: "",
      email: "",
      phone: "",
      linkedin: "",
      github: "",
      website: "",
      location: "",
      headline: "",
      summary: "",
      skills: [],
      languages: [],
    };
    repaired.profileEvidence = [];
    repaired.insights = [];
    repaired.detailedNotes = "";
    repaired.unknowns = [];
    repaired.prohibitedInferences = [];
    const codex = mockCodex([
      first,
      mockCoverage({
        complete: false,
        missingEvidence: [
          {
            quote: "Implemented durable workflow recovery for failed jobs.",
            reason: "Material implementation evidence was omitted.",
            category: "experience",
            findingId: "missing-claim-1",
            operation: "add",
            target: "claims",
            field: "workflow recovery",
            severity: "blocking",
          },
        ],
      }),
      {
        additions: repaired,
        removals: [],
        resolutions: [
          {
            findingId: "missing-claim-1",
            status: "applied",
            reason: "Added the omitted source-supported claim.",
          },
        ],
      },
      mockCoverage(),
    ]);

    const output = await readCandidateSourceChunks({
      codex: codex.client,
      cwd,
      workspace,
      model: "mock-model",
    });

    const readers = codex.calls.filter(
      (call) => call.thread.callId === "evidence.chunk-analysis",
    );
    expect(readers).toHaveLength(1);
    const repairs = codex.calls.filter(
      (call) => call.thread.callId === "evidence.chunk-repair",
    );
    expect(repairs).toHaveLength(1);
    expect(repairs[0].turn.prompt).toContain(
      "Implemented durable workflow recovery for failed jobs.",
    );
    expect(output.sourceInsights[0].claims).toHaveLength(1);
    expect(output.sourceNotes[0].chunks[0].profileFacts.name).toBe(
      "Mira Example",
    );
  });

  it("02.6 terminates as needs-review after three bounded patch rounds", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "inspection-reader-stop-"));
    const workspace = mockWorkspaceWithCv();
    const failure = mockCoverage({
      complete: false,
      unsupportedExtractions: ["Unsupported seniority claim"],
    });
    const codex = mockCodex([
      mockChunkNotes(workspace.sources[0].id),
      failure,
      {
        additions: {
          ...mockChunkNotes(workspace.sources[0].id),
          profileFacts: {
            name: "",
            email: "",
            phone: "",
            linkedin: "",
            github: "",
            website: "",
            location: "",
            headline: "",
            summary: "",
            skills: [],
            languages: [],
          },
          profileEvidence: [],
          insights: [],
          detailedNotes: "",
          claims: [],
          unknowns: [],
          prohibitedInferences: [],
        },
        removals: [],
        resolutions: [],
      },
      failure,
      {
        additions: {
          ...mockChunkNotes(workspace.sources[0].id),
          profileFacts: {
            name: "",
            email: "",
            phone: "",
            linkedin: "",
            github: "",
            website: "",
            location: "",
            headline: "",
            summary: "",
            skills: [],
            languages: [],
          },
          profileEvidence: [],
          insights: [],
          detailedNotes: "",
          claims: [],
          unknowns: [],
          prohibitedInferences: [],
        },
        removals: [],
        resolutions: [],
      },
      failure,
      {
        additions: {
          ...mockChunkNotes(workspace.sources[0].id),
          profileFacts: {
            name: "",
            email: "",
            phone: "",
            linkedin: "",
            github: "",
            website: "",
            location: "",
            headline: "",
            summary: "",
            skills: [],
            languages: [],
          },
          profileEvidence: [],
          insights: [],
          detailedNotes: "",
          claims: [],
          unknowns: [],
          prohibitedInferences: [],
        },
        removals: [],
        resolutions: [],
      },
      failure,
    ]);

    await expect(
      readCandidateSourceChunks({
        codex: codex.client,
        cwd,
        workspace,
        model: "mock-model",
      }),
    ).rejects.toMatchObject({ name: "EvidenceCoverageNeedsReviewError" });
    expect(codex.calls).toHaveLength(8);
  });
});
