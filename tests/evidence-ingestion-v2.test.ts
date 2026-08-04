import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexCandidateAnalyzerV2 } from "../src/01-evidence-ingestion/v2/index.js";
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
                  ],
                  claims: [
                    {
                      capability: "workflow orchestration",
                      action: "Implemented durable workflow recovery for failed jobs.",
                      toolsMethods: ["workflow recovery"],
                      maturity: "implemented",
                      scope: "system",
                      ownership: "primary",
                      quote: "Implemented durable workflow recovery for failed jobs.",
                      limitations: [],
                      startDate: "",
                      endDate: "",
                      outcomes: [],
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

    expect(roles).toEqual([
      "candidate-source-reader",
      "candidate-intelligence",
    ]);
    expect(roles).not.toContain("candidate-source-coverage-verifier");
    expect(roles).not.toContain("candidate-source-repairer");
    expect(result.profile.headline).toBe("Platform Engineer");
    expect(result.sourceInsights[0].sourceId).toBe(workspace.sources[0].id);
    expect(result.sourceInsights[0].insights).toHaveLength(1);
    expect(result.sourceInsights[0].claims).toHaveLength(1);
  });

  it("keeps the lean contract inside the existing exact-quote gateway", () => {
    const workspace = mockWorkspaceWithCv();
    const job = prepareCandidateSourceChunks(workspace).jobs[0];
    const valid = {
      profileFacts: [
        { field: "name", value: "Mira Example", quote: "Mira Example" },
      ],
      claims: [
        {
          capability: "workflow orchestration",
          action: "Implemented durable workflow recovery for failed jobs.",
          toolsMethods: ["workflow recovery"],
          maturity: "implemented",
          scope: "system",
          ownership: "primary",
          quote: "Implemented durable workflow recovery for failed jobs.",
          limitations: [],
          startDate: "",
          endDate: "",
          outcomes: [],
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
    expect(evaluateResultGateway({
      callId: "evidence.chunk-analysis",
      finalText: JSON.stringify({
        ...valid,
        claims: [{ ...valid.claims[0], quote: "not present in source" }],
      }),
      outputSchema: leanChunkOutputSchema,
      prompt,
    }).report.defects.some((defect) => defect.code === "SOURCE_TEXT_NOT_IN_INPUT")).toBe(true);
  });

  it("keeps every strict object property required for OpenAI structured output", () => {
    const missing = strictSchemaMissingRequiredProperties(leanChunkOutputSchema);
    expect(missing).toEqual([]);
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
