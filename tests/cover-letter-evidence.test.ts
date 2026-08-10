import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JobSearchWorkspace } from "../src/contracts/job-search.js";
import type { CodexExecClient } from "../src/codex-runtime/client.js";
import { CodexCoverLetterWriter } from "../src/04-application-preparation/application-preparation.js";

describe("cover-letter evidence loading", () => {
  it("loads only Tier 2 notes cited by the target job", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "rolegain-knowledge-"));
    const knowledgeDirectory = path.join(
      dataRoot,
      "job-search",
      "runs",
      "candidate-1",
      "knowledge",
    );
    await mkdir(knowledgeDirectory, { recursive: true });
    await writeFile(
      path.join(knowledgeDirectory, "relevant.md"),
      "Implemented gas-aware Solidity order routing.",
    );
    await writeFile(
      path.join(knowledgeDirectory, "irrelevant.md"),
      "IRRELEVANT_PRIVATE_DETAIL",
    );

    let writerPrompt = "";
    const codex = {
      start: async () => ({ authenticated: true, model: "test-model" }),
      startThread: async ({ role }: { role: string }) => ({ id: role }),
      runTurn: async ({ threadId, prompt }: { threadId: string; prompt: string }) => {
        if (threadId === "application-company-researcher") {
          return {
            finalText: JSON.stringify({
              company: "Dex Co",
              overview: "Dex Co builds decentralized trading infrastructure.",
              productsAndServices: ["Decentralized exchange infrastructure"],
              customersAndMarkets: ["On-chain trading teams"],
              businessModel: "Protocol services",
              cultureAndValues: ["Protocol reliability"],
              recentSignals: [],
              tailoringAngles: [
                "Connect verified routing work to reliable exchange infrastructure",
              ],
              sources: [
                {
                  title: "Dex Co",
                  url: "https://example.test/company",
                  evidence: "The company page describes exchange infrastructure.",
                },
              ],
            }),
          };
        }
        if (threadId === "cover-letter-writer") {
          writerPrompt = prompt;
          return {
            finalText: JSON.stringify({
              drafts: [
                {
                  applicationId: "app-1",
                  coverLetter: "Grounded cover letter",
                  answers: [],
                },
              ],
            }),
          };
        }
        return {
          finalText: JSON.stringify({
            verifications: [
              {
                applicationId: "app-1",
                verdict: "pass",
                findings: [],
                repairInstructions: [],
              },
            ],
          }),
        };
      },
    } as unknown as CodexExecClient;
    const workspace = minimalWorkspace();
    const writer = new CodexCoverLetterWriter(codex, dataRoot, dataRoot);

    await writer.draft(workspace, ["app-1"]);

    expect(writerPrompt).toContain("Implemented gas-aware Solidity order routing.");
    expect(writerPrompt).toContain(
      "Dex Co builds decentralized trading infrastructure.",
    );
    expect(writerPrompt).not.toContain("IRRELEVANT_PRIVATE_DETAIL");
    expect(writerPrompt).not.toContain("RAW_SOURCE_SHOULD_NOT_BE_READ");
  });

  it("accepts grounded drafts with candidate-owned blanks as needs input without repair", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "rolegain-needs-input-"));
    const workspace = minimalWorkspace();
    workspace.applications[0].companyResearch = {
      status: "ready",
      company: "Dex Co",
      overview: "Decentralized exchange infrastructure.",
      productsAndServices: [],
      customersAndMarkets: [],
      businessModel: "Protocol services",
      cultureAndValues: [],
      recentSignals: [],
      tailoringAngles: [],
      sources: [],
      researchedAt: new Date().toISOString(),
    };
    workspace.applications[0].formFields.push({
      id: "current-location",
      canonicalKey: "current_location",
      externalName: "location",
      label: "Current location",
      type: "text",
      value: "",
      required: true,
      source: "user",
      confidence: 0,
    });
    let repairCalls = 0;
    const codex = {
      start: async () => ({ authenticated: true, model: "test-model" }),
      startThread: async ({ role }: { role: string }) => ({ id: role }),
      runTurn: async ({ threadId }: { threadId: string }) => {
        if (threadId === "cover-letter-writer")
          return {
            finalText: JSON.stringify({
              drafts: [
                {
                  applicationId: "app-1",
                  coverLetter: "Grounded cover letter",
                  answers: [],
                },
              ],
            }),
          };
        if (threadId === "application-draft-repairer") {
          repairCalls += 1;
          throw new Error("repair should not run for candidate input");
        }
        return {
          finalText: JSON.stringify({
            verifications: [
              {
                applicationId: "app-1",
                verdict: "needs_input",
                findings: ["Current location must be supplied by the candidate"],
                repairInstructions: [],
              },
            ],
          }),
        };
      },
    } as unknown as CodexExecClient;

    const drafts = await new CodexCoverLetterWriter(
      codex,
      dataRoot,
      dataRoot,
    ).draft(workspace, ["app-1"]);

    expect(drafts).toHaveLength(1);
    expect(repairCalls).toBe(0);
  });
});

function minimalWorkspace(): JobSearchWorkspace {
  const now = new Date().toISOString();
  return {
    id: "candidate-1",
    candidateId: "candidate-1",
    phase: "applications",
    discoveryNeedsRun: false,
    profile: {
      name: "Nina Novak",
      email: "nina@example.test",
      phone: "",
      linkedin: "",
      github: "",
      website: "",
      location: "Bratislava",
      headline: "Smart contract engineer",
      summary: "Builds decentralized trading systems.",
      salaryExpectation: "",
      targetLocations: "",
      workplace: "remote",
      employmentTypes: "",
      workAuthorization: "",
      startDate: "",
      skills: ["Solidity"],
      languages: ["English"],
    },
    sources: [
      {
        id: "source-relevant",
        kind: "repository",
        name: "dex",
        content: "RAW_SOURCE_SHOULD_NOT_BE_READ",
        knowledgePath:
          "job-search/runs/candidate-1/knowledge/relevant.md",
        status: "ready",
        insights: [
          {
            id: "E1",
            title: "DEX routing",
            summary: "Built order routing.",
            evidence: "Implemented order routing",
            skills: ["Solidity"],
            category: "project",
            detailRef:
              "job-search/runs/candidate-1/knowledge/relevant.md",
          },
        ],
        addedAt: now,
      },
      {
        id: "source-irrelevant",
        kind: "document",
        name: "unrelated",
        knowledgePath:
          "job-search/runs/candidate-1/knowledge/irrelevant.md",
        status: "ready",
        insights: [],
        addedAt: now,
      },
    ],
    questions: [],
    opportunities: [
      {
        id: "job-1",
        company: "Dex Co",
        title: "Solidity Engineer",
        location: "Remote",
        workplace: "remote",
        compensation: "",
        sourceUrl: "https://example.test/job",
        applyUrl: "https://example.test/apply",
        capturedAt: now,
        fit: 90,
        summary: "Build DeFi trading systems.",
        requirements: ["Solidity"],
        requirementMatches: [
          {
            id: "r1",
            kind: "required",
            requirement: "Solidity",
            status: "matched",
            explanation: "Direct evidence.",
            evidence: [
              {
                sourceId: "source-relevant",
                sourceName: "dex",
                excerpt: "Implemented order routing",
              },
            ],
          },
        ],
        strengths: ["Solidity"],
        gaps: [],
      },
    ],
    applications: [
      {
        id: "app-1",
        jobId: "job-1",
        status: "ready_to_send",
        coverLetter: "",
        coverLetterChat: [],
        formFields: [
          {
            id: "cover",
            canonicalKey: "cover_letter",
            label: "Cover letter",
            type: "textarea",
            value: "",
            required: true,
            source: "generated",
            confidence: 0,
          },
        ],
        missingQuestions: [],
        adapter: "generic",
        liveFormValidated: true,
        updatedAt: now,
      },
    ],
    rejectedOpportunities: [],
    searchValidationIssues: [],
    searchReadyOpportunities: [],
    jobHistory: [],
    seenJobUrls: [],
    searchConfig: { discoveryTarget: 20, applicationTarget: 5 },
    sharedAnswers: {},
    profileCompleteness: 100,
    finalCv: "",
    intelligence: { status: "ready" },
    updatedAt: now,
  };
}
