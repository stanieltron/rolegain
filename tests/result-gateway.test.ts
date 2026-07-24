import { describe, expect, it } from "vitest";
import {
  evaluateResultGateway,
  RESULT_GATEWAY_CALL_IDS,
} from "../src/codex-runtime/result-gateway.js";

const objectSchema = {
  type: "object",
  additionalProperties: true,
} as const;

describe("deterministic LLM result gateway", () => {
  it("registers every product call", () => {
    for (const callId of RESULT_GATEWAY_CALL_IDS) {
      const result = evaluateResultGateway({
        callId,
        finalText: "{}",
        outputSchema: objectSchema,
        prompt: "test input",
      });
      expect(
        result.report.defects.some((defect) => defect.code === "UNREGISTERED_LLM_CALL"),
        callId,
      ).toBe(false);
    }
  });

  it("rejects invalid JSON and schema mismatches with structured defects", () => {
    const invalidJson = evaluateResultGateway({
      callId: "application.answer-refine",
      finalText: "not-json",
      outputSchema: objectSchema,
      prompt: "input",
    });
    expect(invalidJson.report.defects[0]).toMatchObject({ code: "INVALID_JSON", path: "$" });

    const invalidShape = evaluateResultGateway({
      callId: "application.answer-refine",
      finalText: "{}",
      outputSchema: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "string" } },
      },
      prompt: "input",
    });
    expect(invalidShape.report.defects).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_MISMATCH" }),
    );
  });

  it("rejects provenance text that is absent from the supplied input", () => {
    const result = evaluateResultGateway({
      callId: "evidence.chunk-analysis",
      finalText: JSON.stringify({ claims: [{ id: "c1", quote: "invented quote" }] }),
      outputSchema: objectSchema,
      prompt: "The supplied CV chunk contains different text.",
    });
    expect(result.report.defects).toContainEqual(
      expect.objectContaining({ code: "SOURCE_TEXT_NOT_IN_INPUT", path: "$.claims[0].quote" }),
    );
  });

  it("deterministically restores exact source line breaks and records the adjustment", () => {
    const result = evaluateResultGateway({
      callId: "evidence.chunk-analysis",
      finalText: JSON.stringify({
        claims: [
          {
            id: "c1",
            quote: "FastAPI, Pydantic, RAG, embeddings, vector and hybrid search",
          },
        ],
      }),
      outputSchema: objectSchema,
      prompt: JSON.stringify({
        content: "FastAPI, Pydantic, RAG, embeddings,\nvector and hybrid search",
      }),
    });
    expect(result.report.accepted).toBe(true);
    expect(result.report.adjustments).toContainEqual(
      expect.objectContaining({ code: "SOURCE_WHITESPACE_ALIGNED" }),
    );
    expect(result.output).toMatchObject({
      claims: [
        {
          quote: "FastAPI, Pydantic, RAG, embeddings,\nvector and hybrid search",
        },
      ],
    });
  });

  it("rejects contradictory verifier and navigation states", () => {
    const verification = evaluateResultGateway({
      callId: "application.verify",
      finalText: JSON.stringify({
        verifications: [
          {
            applicationId: "a1",
            verdict: "pass",
            findings: ["unsupported claim"],
            repairInstructions: [],
          },
        ],
      }),
      outputSchema: objectSchema,
      prompt: "input",
    });
    expect(verification.report.defects).toContainEqual(
      expect.objectContaining({ code: "INCONSISTENT_VERIFICATION_VERDICT" }),
    );

    const navigation = evaluateResultGateway({
      callId: "search.source-navigation",
      finalText: JSON.stringify({
        action: "stop",
        controlId: "",
        completion: "continue",
        reason: "done",
      }),
      outputSchema: objectSchema,
      prompt: "input",
    });
    expect(navigation.report.defects).toContainEqual(
      expect.objectContaining({ code: "INCONSISTENT_NAVIGATION_STATE" }),
    );
  });

  it("fails closed when a new LLM call lacks a gateway registration", () => {
    const result = evaluateResultGateway({
      callId: "unregistered.call",
      finalText: "{}",
      outputSchema: objectSchema,
      prompt: "input",
    });
    expect(result.report.defects).toContainEqual(
      expect.objectContaining({ code: "UNREGISTERED_LLM_CALL" }),
    );
  });
});
