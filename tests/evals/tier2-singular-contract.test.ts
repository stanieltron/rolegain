import { describe, expect, it } from "vitest";
import { evaluateResultGateway } from "../../src/codex-runtime/result-gateway.js";
import { outputSchema } from "../../src/03-match/01-requirement-matching/llm-calls/02-tier2-matching/output.js";

describe("singular per-job Tier-2 output contract", () => {
  it("accepts multiple unresolved requirements under one job", () => {
    const result = evaluateResultGateway({
      callId: "match.tier2-evidence",
      finalText: JSON.stringify({
        jobId: "job-1",
        requirements: [
          missingRow("Professional TypeScript experience is required."),
          missingRow("Kubernetes experience is preferred.", "preferred"),
        ],
      }),
      outputSchema,
      prompt: "job-1 TypeScript Kubernetes",
    });
    expect(result.report.accepted).toBe(true);
  });

  it("rejects the obsolete batch wrapper at schema validation", () => {
    const result = evaluateResultGateway({
      callId: "match.tier2-evidence",
      finalText: JSON.stringify({
        assessments: [
          {
            jobId: "job-1",
            requirements: [missingRow("Requirement A")],
          },
          {
            jobId: "job-1",
            requirements: [missingRow("Requirement B")],
          },
        ],
      }),
      outputSchema,
      prompt: "job-1 Requirement A Requirement B",
    });
    expect(result.report.accepted).toBe(false);
    expect(result.report.defects).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_MISMATCH" }),
    );
  });

  it("still rejects a genuinely duplicated requirement row", () => {
    const row = missingRow("Kubernetes experience is preferred.", "preferred");
    const result = evaluateResultGateway({
      callId: "match.tier2-evidence",
      finalText: JSON.stringify({
        jobId: "job-1",
        requirements: [row, row],
      }),
      outputSchema,
      prompt: "job-1 Kubernetes experience is preferred.",
    });
    expect(result.report.defects).toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_REQUIREMENT" }),
    );
  });
});

function missingRow(
  requirement: string,
  kind: "required" | "preferred" = "required",
) {
  return {
    kind,
    category: kind === "preferred" ? "preferred" : "mandatory",
    requirement,
    status: "missing",
    matchClass: "unsupported",
    confidence: 1,
    gapClass: "evidence_quality",
    gapSeverity: "blocking",
    normalizedCapability: requirement.toLowerCase(),
    minimumDuration: 0,
    requiredOwnership: "",
    requiredMaturity: "",
    requiredScope: "",
    requiredWorkContext: "",
    requiredToolMethod: "",
    requiredCredential: "",
    ambiguityFlags: [],
    sourceLocator: "qualificationText",
    explanation: "No supporting evidence was found.",
    evidence: [],
  };
}
