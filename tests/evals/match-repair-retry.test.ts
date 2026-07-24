import { describe, expect, it } from "vitest";
import {
  verifyAndRepairAssessments,
  type AgentRequirementAssessment,
} from "../../src/03-match/01-requirement-matching/index.js";
import type { JobOpportunity } from "../../src/contracts/job-search.js";
import type { CodexExecClient } from "../../src/codex-runtime/client.js";
import {
  ResultGatewayError,
  type ResultGatewayDefect,
} from "../../src/codex-runtime/result-gateway.js";

describe("match repair recovery", () => {
  it("retries one duplicate-requirement gateway failure with a bounded correction prompt", async () => {
    const prompts: string[] = [];
    let verificationCalls = 0;
    let repairCalls = 0;
    const corrected = assessment([
      requirement("Lead a platform engineering team.", "missing"),
      requirement("Own the technical strategy.", "missing"),
    ]);
    const codex = {
      startThread: async ({ callId }: { callId: string }) => ({ id: callId }),
      runTurn: async ({
        threadId,
        prompt,
      }: {
        threadId: string;
        prompt: string;
      }) => {
        if (threadId === "match.verification") {
          verificationCalls += 1;
          return {
            finalText: JSON.stringify({
              jobId: "job-1",
              verdict:
                verificationCalls === 1 ? "needs_repair" : "pass",
              findings:
                verificationCalls === 1
                  ? [
                      {
                        code: "duplicate",
                        requirement:
                          "Lead a platform engineering team and own the technical strategy.",
                        message: "Split or consolidate the duplicate rows.",
                      },
                    ]
                  : [],
              repairInstructions:
                verificationCalls === 1
                  ? ["Return each employer requirement exactly once."]
                  : [],
            }),
          };
        }
        repairCalls += 1;
        prompts.push(prompt);
        if (repairCalls === 1)
          throw gatewayError({
            code: "DUPLICATE_REQUIREMENT",
            path: "$.requirements[1].requirement",
            message: "A requirement may appear only once in one assessment",
            received:
              "Lead a platform engineering team and own the technical strategy.",
          });
        return { finalText: JSON.stringify(corrected) };
      },
    } as unknown as CodexExecClient;

    const result = await verifyAndRepairAssessments(
      codex,
      process.cwd(),
      "test-model",
      [],
      [opportunity()],
      [
        assessment([
          requirement(
            "Lead a platform engineering team and own the technical strategy.",
            "missing",
          ),
        ]),
      ],
    );

    expect(repairCalls).toBe(2);
    expect(prompts[1]).toContain("DUPLICATE_REQUIREMENT");
    expect(prompts[1]).toContain("distinct faithful atomic-clause text");
    expect(result.assessments).toEqual([corrected]);
    expect(result.rejected).toEqual([]);
  });

  it("does not retry non-repairable gateway failures", async () => {
    let repairCalls = 0;
    const codex = {
      startThread: async ({ callId }: { callId: string }) => ({ id: callId }),
      runTurn: async ({ threadId }: { threadId: string }) => {
        if (threadId === "match.verification")
          return {
            finalText: JSON.stringify({
              jobId: "job-1",
              verdict: "needs_repair",
              findings: [],
              repairInstructions: ["Repair the malformed result."],
            }),
          };
        repairCalls += 1;
        throw gatewayError({
          code: "SCHEMA_MISMATCH",
          path: "$",
          message: "Output does not satisfy its JSON Schema",
        });
      },
    } as unknown as CodexExecClient;

    await expect(
      verifyAndRepairAssessments(
        codex,
        process.cwd(),
        "test-model",
        [],
        [opportunity()],
        [assessment([requirement("Own the technical strategy.", "missing")])],
      ),
    ).rejects.toBeInstanceOf(ResultGatewayError);
    expect(repairCalls).toBe(1);
  });
});

function gatewayError(defect: ResultGatewayDefect) {
  return new ResultGatewayError({
    accepted: false,
    callId: "match.repair",
    checks: ["call-specific-invariants"],
    defects: [defect],
    adjustments: [],
    evaluatedAt: new Date(0).toISOString(),
  });
}

function assessment(
  requirements: AgentRequirementAssessment["requirements"],
): AgentRequirementAssessment {
  return { jobId: "job-1", requirements };
}

function requirement(
  text: string,
  status: "matched" | "partial" | "missing",
): AgentRequirementAssessment["requirements"][number] {
  return {
    kind: "required",
    category: "responsibility",
    requirement: text,
    status,
    matchClass: status === "missing" ? "unsupported" : "explicit",
    confidence: 0.99,
    gapClass: status === "missing" ? "evidence_quality" : "none",
    gapSeverity: status === "missing" ? "blocking" : "none",
    normalizedCapability: text,
    minimumDuration: 0,
    requiredOwnership: "",
    requiredMaturity: "",
    requiredScope: "",
    requiredWorkContext: "",
    requiredToolMethod: "",
    requiredCredential: "",
    ambiguityFlags: [],
    sourceLocator: "responsibilitiesText",
    explanation: "No direct supporting evidence was supplied.",
    evidence: [],
  };
}

function opportunity(): JobOpportunity {
  return {
    id: "job-1",
    company: "Eval Employer",
    title: "Platform Engineering Lead",
    location: "Remote",
    workplace: "Remote",
    compensation: "",
    sourceUrl: "https://example.test/job-1",
    applyUrl: "https://example.test/job-1/apply",
    capturedAt: new Date(0).toISOString(),
    fit: 0,
    summary: "Lead a platform engineering team and own the technical strategy.",
    description:
      "Core Responsibilities:\n- Lead a platform engineering team and own the technical strategy.",
    requirements: [],
    requirementMatches: [],
    strengths: [],
    gaps: [],
  };
}
