import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexCandidateAnalyzerV2 } from "../src/01-evidence-ingestion/v2/index.js";
import {
  EVIDENCE_V2_CHUNK_MAX_CHARS,
  chunkSourceForAnalysisV2,
  evidenceAnalysisConcurrencyV2,
} from "../src/01-evidence-ingestion/v2/reader.js";
import {
  buildLeanChunkInput,
  leanChunkOutputSchema,
} from "../src/01-evidence-ingestion/v2/lean-contract.js";
import { prepareCandidateSourceChunks } from "../src/01-evidence-ingestion/v1/02-chunk-reader/index.js";
import {
  mockSynthesis,
  mockWorkspaceWithCv,
} from "../src/01-evidence-ingestion/inspection/fixtures.js";
import type {
  StartThreadOptions,
  StartTurnOptions,
} from "../src/codex-runtime/client.js";
import { CodexExecClient } from "../src/codex-runtime/client.js";
import { runtimeConfiguration } from "../src/config/runtime.js";
import { evaluateResultGateway } from "../src/codex-runtime/result-gateway.js";
import { normalizeCandidateAnalysisProfileLists } from "../src/01-evidence-ingestion/04-verification/index.js";

describe("evidence ingestion v2", () => {
  it("is explicitly selectable while v1 remains the rollback default", () => {
    expect(runtimeConfiguration({}).evidenceIngestionVersion).toBe("v1");
    expect(
      runtimeConfiguration({ ROLEGAIN_EVIDENCE_VERSION: "v2" })
        .evidenceIngestionVersion,
    ).toBe("v2");
  });

  it("runs one reader call per chunk and synthesis without coverage or repair", async () => {
    const workspace = mockWorkspaceWithCv();
    const roles: string[] = [];
    const readerEfforts: Array<StartTurnOptions["effort"]> = [];
    const threadRoles = new Map<string, string>();
    const codex = {
      start: async () => ({
        available: true,
        binary: "codex",
        version: "test",
        compatible: true,
        authenticated: true,
        authMode: "chatgpt",
        model: "test-model",
        models: [],
      }),
      startThread: async (options: StartThreadOptions) => {
        roles.push(options.role);
        const id = `thread-${roles.length}`;
        threadRoles.set(id, options.role);
        return { id, modelProvider: "openai" };
      },
      runTurn: async (options: StartTurnOptions) => {
        const role = threadRoles.get(options.threadId);
        if (role === "candidate-source-reader") readerEfforts.push(options.effort);
        return {
          threadId: options.threadId,
          turnId: `turn-${roles.length}`,
          status: "completed" as const,
          finalText: JSON.stringify(
            role === "candidate-source-reader"
              ? {
                  profileFacts: [
                    { field: "name", value: "Mira Example", quote: "Mira Example" },
                    { field: "email", value: "mira@example.test", quote: "mira@example.test" },
                    { field: "headline", value: "Platform Engineer", quote: "Platform Engineer" },
                  ],
                  claims: [
                    {
                      fact: "Implemented durable workflow recovery for failed jobs.",
                      capability: "workflow orchestration",
                      keywords: ["workflow recovery"],
                      maturity: "implemented",
                      scope: "system",
                      ownership: "primary",
                      quote: "Implemented durable workflow recovery for failed jobs.",
                    },
                  ],
                }
              : mockSynthesis(workspace),
          ),
          items: [],
        };
      },
    } as unknown as CodexExecClient;
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-evidence-v2-"));

    const result = await new CodexCandidateAnalyzerV2(codex, root).analyze(
      workspace,
    );

    expect(roles).toHaveLength(2);
    expect(roles).toContain("candidate-source-reader");
    expect(roles).toContain("candidate-intelligence");
    expect(roles).not.toContain("candidate-source-coverage-verifier");
    expect(roles).not.toContain("candidate-source-repairer");
    expect(readerEfforts).toEqual(["low"]);
    expect(result.profile.headline).toBe("Platform Engineer");
    expect(result.sourceInsights[0].sourceId).toBe(workspace.sources[0].id);
    expect(result.sourceInsights[0].insights).toHaveLength(1);
    expect(result.sourceInsights[0].claims).toHaveLength(1);
    expect(result.sourceInsights[0]!.claims![0]!).toMatchObject({
      startDate: "",
      endDate: "",
      outcomes: [],
      limitations: [],
    });
  });

  it("isolates captured pages and bounds each dense page to 20k chunks", () => {
    const pageA = `Page: https://example.test/a\n${"alpha evidence ".repeat(1_900)}`;
    const pageB = `Page: https://example.test/b\n${"beta evidence ".repeat(200)}`;
    const chunks = chunkSourceForAnalysisV2({
      kind: "webpage",
      content: `${pageA}\n${pageB}`,
    });

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.content.length <= EVIDENCE_V2_CHUNK_MAX_CHARS)).toBe(true);
    expect(chunks.slice(0, 2).every((chunk) => chunk.locator.startsWith("https://example.test/a; lines "))).toBe(true);
    expect(chunks[2].locator).toMatch(/^https:\/\/example\.test\/b; lines /);
    expect(chunks.slice(0, 2).every((chunk) => !chunk.content.includes("https://example.test/b"))).toBe(true);
  });

  it("uses twenty-way v2 fan-out by default with a bounded explicit override", () => {
    expect(evidenceAnalysisConcurrencyV2({})).toBe(20);
    expect(evidenceAnalysisConcurrencyV2({ ROLEGAIN_ANALYSIS_CONCURRENCY: "3" })).toBe(20);
    expect(evidenceAnalysisConcurrencyV2({ ROLEGAIN_EVIDENCE_V2_CONCURRENCY: "4" })).toBe(4);
    expect(evidenceAnalysisConcurrencyV2({ ROLEGAIN_EVIDENCE_V2_CONCURRENCY: "99" })).toBe(20);
  });

  it("keeps the lean contract inside the exact-quote gateway without failing the chunk", () => {
    const workspace = mockWorkspaceWithCv();
    const job = prepareCandidateSourceChunks(workspace).jobs[0];
    const valid = {
      profileFacts: [
        { field: "name", value: "Mira Example", quote: "Mira Example" },
      ],
      claims: [
        {
          fact: "Implemented durable workflow recovery for failed jobs.",
          capability: "workflow orchestration",
          keywords: ["workflow recovery"],
          maturity: "implemented",
          scope: "system",
          ownership: "primary",
          quote: "Implemented durable workflow recovery for failed jobs.",
        },
      ],
    };
    const prompt = buildLeanChunkInput(job);

    expect(evaluateResultGateway({
      callId: "evidence.chunk-analysis",
      finalText: JSON.stringify(valid),
      outputSchema: leanChunkOutputSchema,
      prompt,
    }).report.accepted).toBe(true);
    const sanitized = evaluateResultGateway({
      callId: "evidence.chunk-analysis",
      finalText: JSON.stringify({
        ...valid,
        profileFacts: [
          ...valid.profileFacts,
          { field: "headline", value: "Invented", quote: "not in source either" },
        ],
        claims: [{ ...valid.claims[0], quote: "not present in source" }],
      }),
      outputSchema: leanChunkOutputSchema,
      prompt,
    });
    expect(sanitized.report.accepted).toBe(true);
    expect(sanitized.report.defects).toEqual([]);
    expect(sanitized.report.adjustments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNGROUNDED_EVIDENCE_DROPPED",
          path: "$.profileFacts[1]",
        }),
        expect.objectContaining({
          code: "UNGROUNDED_CLAIM_DROPPED",
          path: "$.claims[0]",
        }),
      ]),
    );
    expect(sanitized.output).toEqual({
      profileFacts: valid.profileFacts,
      claims: [],
    });
  });

  it("keeps every strict object property required for OpenAI structured output", () => {
    const missing = strictSchemaMissingRequiredProperties(leanChunkOutputSchema);
    expect(missing).toEqual([]);
    const claimProperties = (((leanChunkOutputSchema.properties as Record<string, unknown>)
      .claims as Record<string, unknown>).items as Record<string, unknown>)
      .properties as Record<string, unknown>;
    expect(Object.keys(claimProperties)).toEqual([
      "fact",
      "capability",
      "keywords",
      "maturity",
      "scope",
      "ownership",
      "quote",
    ]);
  });

  it("atomizes list-shaped profile facts before shared v1/v2 provenance verification", () => {
    const workspace = mockWorkspaceWithCv();
    const analysis = {
      ...mockSynthesis(workspace),
      profile: {
        ...workspace.profile,
        skills: ["Rust, TypeScript; vector and hybrid search", "rust"],
        languages: ["English | Slovak"],
      },
      profileEvidence: [
        {
          field: "skills" as const,
          value: "Rust, TypeScript; vector and hybrid search",
          sourceId: workspace.sources[0].id,
          locator: "lines 1-2",
          quote: "Rust, TypeScript, vector and hybrid search",
        },
      ],
      sourceInsights: [],
      threadId: "thread-normalize",
    };

    const normalized = normalizeCandidateAnalysisProfileLists(analysis);

    expect(normalized.profile.skills).toEqual([
      "Rust",
      "TypeScript",
      "vector and hybrid search",
    ]);
    expect(normalized.profile.languages).toEqual(["English", "Slovak"]);
    expect(normalized.profileEvidence?.map((item) => item.value)).toEqual([
      "Rust",
      "TypeScript",
      "vector and hybrid search",
    ]);
  });
});

function strictSchemaMissingRequiredProperties(
  schema: unknown,
  path = "$",
): string[] {
  if (!schema || typeof schema !== "object") return [];
  const value = schema as Record<string, unknown>;
  const missing: string[] = [];
  if (value.type === "object" && isRecord(value.properties)) {
    const required = new Set(
      Array.isArray(value.required)
        ? value.required.filter((item): item is string => typeof item === "string")
        : [],
    );
    for (const key of Object.keys(value.properties)) {
      if (!required.has(key)) missing.push(`${path}.properties.${key}`);
      missing.push(
        ...strictSchemaMissingRequiredProperties(
          value.properties[key],
          `${path}.properties.${key}`,
        ),
      );
    }
  }
  if (value.items)
    missing.push(...strictSchemaMissingRequiredProperties(value.items, `${path}.items`));
  return missing;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
