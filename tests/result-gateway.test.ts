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

  it("deduplicates repeated web-discovery URLs instead of rejecting the wave", () => {
    const job = {
      jobUrl: "https://jobs.example.test/role-1",
      applyUrl: "https://jobs.example.test/role-1/apply",
    };
    const result = evaluateResultGateway({
      callId: "search.web-discovery",
      finalText: JSON.stringify({ jobs: [job, { ...job }] }),
      outputSchema: objectSchema,
      prompt: "Find current jobs.",
    });

    expect(result.report.accepted).toBe(true);
    expect(result.report.adjustments).toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_RESULT_DROPPED" }),
    );
    expect(result.output).toEqual({ jobs: [job] });
  });

  it("deduplicates and validates search-v2 discovery URLs", () => {
    const job = { url: "https://jobs.example.test/role-1" };
    const result = evaluateResultGateway({
      callId: "search.web-discovery",
      finalText: JSON.stringify({ jobs: [job, { ...job }] }),
      outputSchema: objectSchema,
      prompt: "Find current jobs.",
    });

    expect(result.report.accepted).toBe(true);
    expect(result.report.adjustments).toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_RESULT_DROPPED" }),
    );
    expect(result.output).toEqual({ jobs: [job] });
  });

  it("keeps a discovery wave when one vacancy applies by email", () => {
    const emailApplication = {
      jobUrl: "https://jobs.example.test/email-role",
      applyUrl: "mailto:careers@example.test",
    };
    const regularApplication = {
      jobUrl: "https://jobs.example.test/web-role",
      applyUrl: "https://jobs.example.test/web-role/apply",
    };
    const result = evaluateResultGateway({
      callId: "search.web-discovery",
      finalText: JSON.stringify({ jobs: [emailApplication, regularApplication] }),
      outputSchema: objectSchema,
      prompt: "Find current jobs.",
    });

    expect(result.report.accepted).toBe(true);
    expect(result.report.adjustments).toContainEqual(
      expect.objectContaining({
        code: "NON_HTTP_APPLY_URL_REPLACED",
        path: "$.jobs[0].applyUrl",
        before: "mailto:careers@example.test",
        after: emailApplication.jobUrl,
      }),
    );
    expect(result.output).toEqual({
      jobs: [
        { ...emailApplication, applyUrl: emailApplication.jobUrl },
        regularApplication,
      ],
    });
  });

  it("removes a non-web apply action from vacancy verification", () => {
    const result = evaluateResultGateway({
      callId: "search.vacancy-verification",
      finalText: JSON.stringify({ applyUrl: "mailto:careers@example.test" }),
      outputSchema: objectSchema,
      prompt: "Verify the vacancy page.",
    });

    expect(result.report.accepted).toBe(true);
    expect(result.output).toEqual({ applyUrl: "" });
    expect(result.report.adjustments).toContainEqual(
      expect.objectContaining({ code: "NON_HTTP_APPLY_URL_REPLACED" }),
    );
  });

  it("normalizes batched search-v2 vacancy classification results", () => {
    const result = evaluateResultGateway({
      callId: "search.vacancy-verification",
      finalText: JSON.stringify({
        results: [
          { id: "lead-1", applyUrl: "mailto:careers@example.test" },
          { id: "lead-2", applyUrl: "https://jobs.example.test/role-2" },
        ],
      }),
      outputSchema: objectSchema,
      prompt: "Classify frozen vacancy captures.",
    });

    expect(result.report.accepted).toBe(true);
    expect(result.output).toEqual({
      results: [
        { id: "lead-1", applyUrl: "" },
        { id: "lead-2", applyUrl: "https://jobs.example.test/role-2" },
      ],
    });
    expect(result.report.adjustments).toContainEqual(
      expect.objectContaining({
        code: "NON_HTTP_APPLY_URL_REPLACED",
        path: "$.results[0].applyUrl",
      }),
    );
  });

  it("drops ungrounded chunk evidence so coverage can repair the omission", () => {
    const result = evaluateResultGateway({
      callId: "evidence.chunk-analysis",
      finalText: JSON.stringify({
        profileEvidence: [
          { field: "skills", value: "Invented", quote: "invented quote" },
        ],
        claims: [
          {
            id: "c1",
            sourceEvidence: [{ quote: "invented quote" }],
          },
        ],
      }),
      outputSchema: objectSchema,
      prompt: "The supplied CV chunk contains different text.",
    });
    expect(result.report.accepted).toBe(true);
    expect(result.report.adjustments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNGROUNDED_EVIDENCE_DROPPED" }),
        expect.objectContaining({ code: "UNGROUNDED_CLAIM_DROPPED" }),
      ]),
    );
    expect(result.output).toMatchObject({
      profileEvidence: [],
      claims: [],
    });
  });

  it("drops only ungrounded coverage findings and preserves the incomplete verdict", () => {
    const result = evaluateResultGateway({
      callId: "evidence.chunk-coverage",
      finalText: JSON.stringify({
        complete: false,
        missingEvidence: [
          {
            quote: "exact source fact",
            reason: "Grounded omission",
          },
          {
            quote: "paraphrased source fact",
            reason: "Ungrounded omission",
          },
        ],
        unsupportedExtractions: [],
        summary: "Repair is required.",
      }),
      outputSchema: objectSchema,
      prompt: "The chunk contains an exact source fact.",
    });
    expect(result.report.accepted).toBe(true);
    expect(result.report.adjustments).toContainEqual(
      expect.objectContaining({
        code: "UNGROUNDED_COVERAGE_FINDING_DROPPED",
      }),
    );
    expect(result.output).toMatchObject({
      complete: false,
      missingEvidence: [
        expect.objectContaining({ quote: "exact source fact" }),
      ],
    });
  });

  it("corrects a complete coverage verdict that still contains blocking findings", () => {
    const result = evaluateResultGateway({
      callId: "evidence.chunk-coverage",
      finalText: JSON.stringify({
        complete: true,
        missingEvidence: [
          {
            findingId: "missing-claim",
            operation: "add",
            target: "claims",
            field: "capability",
            severity: "blocking",
            quote: "exact source fact",
            reason: "A material claim is missing.",
            category: "experience",
          },
        ],
        unsupportedExtractions: [],
        summary: "A repair is required.",
      }),
      outputSchema: objectSchema,
      prompt: "The chunk contains an exact source fact.",
    });
    expect(result.report.accepted).toBe(true);
    expect(result.report.adjustments).toContainEqual(
      expect.objectContaining({ code: "COVERAGE_VERDICT_CORRECTED" }),
    );
    expect(result.output).toMatchObject({ complete: false });
  });

  it("renames duplicate coverage finding ids without dropping grounded findings", () => {
    const finding = {
      findingId: "missing-claim",
      operation: "add",
      target: "claims",
      field: "capability",
      severity: "blocking",
      quote: "exact source fact",
      reason: "A material claim is missing.",
      category: "experience",
    };
    const result = evaluateResultGateway({
      callId: "evidence.chunk-coverage",
      finalText: JSON.stringify({
        complete: false,
        missingEvidence: [
          finding,
          { ...finding, reason: "A second material claim is missing." },
        ],
        unsupportedExtractions: [],
        summary: "Repair is required.",
      }),
      outputSchema: objectSchema,
      prompt: "The chunk contains an exact source fact.",
    });

    expect(result.report.accepted).toBe(true);
    expect(result.report.adjustments).toContainEqual(
      expect.objectContaining({
        code: "DUPLICATE_IDENTITY_RENAMED",
        path: "$.missingEvidence[1].findingId",
        before: "missing-claim",
        after: "missing-claim-2",
      }),
    );
    expect(result.output).toMatchObject({
      missingEvidence: [
        expect.objectContaining({ findingId: "missing-claim" }),
        expect.objectContaining({ findingId: "missing-claim-2" }),
      ],
    });
  });

  it("drops orphaned repair removals instead of applying an unresolved deletion", () => {
    const result = evaluateResultGateway({
      callId: "evidence.chunk-repair",
      finalText: JSON.stringify({
        additions: {
          profileEvidence: [],
          claims: [],
        },
        removals: [
          {
            target: "claim",
            match: "unsupported claim",
            findingId: "missing-resolution",
            reason: "Remove unsupported material.",
          },
        ],
        resolutions: [],
      }),
      outputSchema: objectSchema,
      prompt: "Source and extraction input.",
    });
    expect(result.report.accepted).toBe(true);
    expect(result.report.adjustments).toContainEqual(
      expect.objectContaining({
        code: "ORPHANED_REPAIR_REMOVAL_DROPPED",
      }),
    );
    expect(result.output).toMatchObject({ removals: [] });
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

  it("rejects browser-form mappings that assign one rendered control twice", () => {
    const result = evaluateResultGateway({
      callId: "application.field-map",
      finalText: JSON.stringify({
        fields: [
          {
            fieldId: "rolegain-control-1",
            controlIds: ["rolegain-control-1"],
            label: "First name",
            canonicalKey: "first_name",
            type: "text",
            required: true,
          },
          {
            fieldId: "rolegain-control-2",
            controlIds: ["rolegain-control-1", "rolegain-control-2"],
            label: "Last name",
            canonicalKey: "last_name",
            type: "text",
            required: true,
          },
        ],
        ignoredControlIds: [],
      }),
      outputSchema: objectSchema,
      prompt: "input",
    });
    expect(result.report.defects).toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_IDENTITY" }),
    );
  });

  it("accepts a semantic logical field id distinct from its browser control id", () => {
    const result = evaluateResultGateway({
      callId: "application.field-map",
      finalText: JSON.stringify({
        fields: [
          {
            fieldId: "first_name",
            controlIds: ["rolegain-control-1"],
            label: "First name",
            canonicalKey: "first_name",
            type: "text",
            required: true,
          },
        ],
        ignoredControlIds: [],
      }),
      outputSchema: objectSchema,
      prompt: "input",
    });
    expect(result.report.accepted).toBe(true);
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
