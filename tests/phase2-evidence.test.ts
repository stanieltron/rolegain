import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CandidateAnalysisResult } from "../src/01-evidence-ingestion/types.js";
import type {
  CandidateSource,
  JobOpportunity,
  JobSearchWorkspace,
} from "../src/contracts/job-search.js";
import type { CodexExecClient } from "../src/codex-runtime/client.js";
import { persistCanonicalEvidenceRun } from "../src/01-evidence-ingestion/04-verification/evidence-model.js";
import { LiveOpportunityResearcher } from "../src/03-match/opportunity-researcher.js";
import { matchOpportunities } from "../src/03-match/shared/01-requirement-matching/index.js";
import { runtimeConfiguration } from "../src/config/runtime.js";
import {
  canonicalCitationIsValid,
  canonicalOpportunityAlignment,
  canonicalOpportunityIsExcluded,
  loadPhase2EvidenceContext,
  phase2DiscoveryPacket,
  phase2QueryPortfolio,
  retrieveCanonicalClaimLedger,
  retrieveKnowledgeRoutes,
} from "../src/search-match-shared/evidence-context.js";

describe("canonical Phase 2 evidence", () => {
  it("keeps matching v1 as the default and selects v2 explicitly", () => {
    expect(runtimeConfiguration({}).matchVersion).toBe("v1");
    expect(
      runtimeConfiguration({ ROLEGAIN_MATCH_VERSION: "v2" }).matchVersion,
    ).toBe("v2");
  });

  it("builds separate search lanes and retrieves claim-level evidence per job", async () => {
    const fixture = await canonicalFixture();
    const context = await loadPhase2EvidenceContext(
      fixture.root,
      fixture.workspace,
    );
    expect(context).toBeDefined();
    const packet = phase2DiscoveryPacket(context!);
    expect(packet.searchLanes.map((lane) => lane.canonicalTitle)).toEqual([
      "Protocol Architect",
      "AI Agent Infrastructure Engineer",
    ]);
    expect(packet.searchLanes[0].queryVariants.length).toBeGreaterThan(1);
    expect(
      new Set(packet.searchLanes[0].queries.map((item) => item.family)),
    ).toEqual(
      new Set([
        "title_baseline",
        "evidence_intersection",
        "problem_language",
        "official_ats",
        "company_first",
        "specialist_local",
        "requirement_inversion",
      ]),
    );
    expect(phase2QueryPortfolio(context!, 0, 1)[0].canonicalTitle).toBe(
      "Protocol Architect",
    );
    expect(phase2QueryPortfolio(context!, 1, 1)[0].canonicalTitle).toBe(
      "Protocol Architect",
    );
    expect(phase2QueryPortfolio(context!, 2, 2).map((query) => query.canonicalTitle)).toEqual([
      "Protocol Architect",
      "AI Agent Infrastructure Engineer",
    ]);
    expect(
      canonicalOpportunityAlignment(context!, {
        title: "AI Agent Infrastructure Engineer",
        description: "TypeScript worker orchestration and verifier gates",
      }),
    ).toBeGreaterThan(
      canonicalOpportunityAlignment(context!, {
        title: "Marketing Manager",
        description: "Run brand campaigns and sales enablement",
      }),
    );
    expect(canonicalOpportunityIsExcluded(context!, "Technical Marketing Manager")).toBe(
      true,
    );
    expect(packet.materialUnknowns).toEqual([
      expect.objectContaining({ field: "work_authorization" }),
    ]);

    const jobs = retrieveCanonicalClaimLedger(context!, [
      opportunity(
        "job-ai",
        "AI Agent Infrastructure Engineer",
        "Build durable worker orchestration and verifier gates in TypeScript.",
      ),
    ]);
    expect(jobs[0].evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "agent control planes",
          supportStatus: "supported",
        }),
      ]),
    );
    const citation = jobs[0].evidence.find(
      (item) => item.capability === "agent control planes",
    )!;
    expect(canonicalCitationIsValid(jobs[0].evidence, citation)).toBe(true);
    expect(
      canonicalCitationIsValid(jobs[0].evidence, {
        ...citation,
        claimId: "claim-not-present",
      }),
    ).toBe(false);
    expect(
      retrieveCanonicalClaimLedger(context!, [
        opportunity(
          "job-marketing",
          "Product Marketing Manager",
          "Lead brand campaigns and sales enablement.",
        ),
      ])[0].evidence,
    ).toEqual([]);
  });

  it("uses wiki retrieval terms to expose canonical evidence for an ambiguous requirement", async () => {
    const fixture = await canonicalFixture();
    const knowledgeIndexFile = path.join(
      fixture.root,
      "job-search",
      "runs",
      fixture.workspace.candidateId,
      "evidence-runs",
      fixture.workspace.intelligence.evidenceRun!.id,
      "knowledge",
      "index.json",
    );
    const knowledgeIndex = JSON.parse(
      await readFile(knowledgeIndexFile, "utf8"),
    ) as {
      pages: Array<{
        title: string;
        keywords: string[];
      }>;
    };
    const agentPage = knowledgeIndex.pages.find(
      (page) => page.title === "agent control planes",
    )!;
    agentPage.keywords.push("complex software delivery");
    await writeFile(
      knowledgeIndexFile,
      `${JSON.stringify(knowledgeIndex, null, 2)}\n`,
      "utf8",
    );

    const context = await loadPhase2EvidenceContext(
      fixture.root,
      fixture.workspace,
    );
    const ambiguousJob = opportunity(
      "job-ambiguous",
      "Technical Specialist",
      "Own complex software delivery under ambiguous requirements.",
    );
    const routes = retrieveKnowledgeRoutes(context!, [ambiguousJob]);
    expect(routes[0].pages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "agent control planes",
          claimIds: expect.arrayContaining([expect.stringMatching(/^claim-/)]),
        }),
      ]),
    );
    expect(routes[0].pages[0].content).toContain("Canonical claim");

    const withoutWiki = { ...context!, knowledgePages: [] };
    expect(
      retrieveCanonicalClaimLedger(withoutWiki, [ambiguousJob])[0].evidence,
    ).toEqual([]);
    expect(
      retrieveCanonicalClaimLedger(context!, [ambiguousJob])[0].evidence,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: "agent control planes" }),
      ]),
    );
  });

  it("matches requirements from canonical claims and preserves their locator", async () => {
    const fixture = await canonicalFixture();
    let assessorPrompt = "";
    const callModels: Array<{ callId: string; model: string }> = [];
    const context = await loadPhase2EvidenceContext(
      fixture.root,
      fixture.workspace,
    );
    const citation = retrieveCanonicalClaimLedger(context!, [
      opportunity(
        "job-ai",
        "AI Agent Infrastructure Engineer",
        "Requires TypeScript worker orchestration and verifier gates.",
      ),
    ])[0].evidence.find((item) => item.capability === "agent control planes")!;
    const codex = {
      start: async () => ({
        authenticated: true,
        model: "test-model",
        models: [{ id: "test-model" }],
      }),
      startThread: async ({
        callId,
        role,
        model,
      }: {
        callId: string;
        role: string;
        model: string;
      }) => {
        callModels.push({ callId, model });
        return { id: role };
      },
      runTurn: async ({ threadId, prompt }: { threadId: string; prompt: string }) => {
        if (threadId === "job-requirement-assessor") {
          assessorPrompt = prompt;
          return {
            finalText: JSON.stringify({
              jobId: "job-ai",
              requirements: [
                {
                  kind: "required",
                  requirement: "TypeScript worker orchestration",
                  status: "matched",
                  explanation:
                    "The candidate implemented a TypeScript control plane with workers and verifier gates.",
                  evidence: [citation],
                },
              ],
            }),
          };
        }
        return {
          finalText: JSON.stringify({
            jobId: "job-ai",
            verdict: "pass",
            findings: [],
            repairInstructions: [],
          }),
        };
      },
    } as unknown as CodexExecClient;
    const researcher = new LiveOpportunityResearcher(
      codex,
      fixture.root,
      fixture.root,
    );
    const result = await researcher.assess(fixture.workspace, [
      opportunity(
        "job-ai",
        "AI Agent Infrastructure Engineer",
        "Requires TypeScript worker orchestration and verifier gates.",
      ),
    ]);
    const assessed = Array.isArray(result) ? result : result.opportunities;
    expect(assessorPrompt).toContain(fixture.workspace.intelligence.evidenceRun!.id);
    expect(assessorPrompt).toContain(citation.claimId);
    expect(assessorPrompt).toContain("knowledgeRoutesByJob");
    expect(assessorPrompt).toContain("This page is a routing and synthesis layer");
    expect(assessorPrompt).not.toContain("LEGACY_INSIGHT_SHOULD_NOT_BE_USED");
    expect(assessed[0].fit).toBe(81);
    expect(assessed[0].scoreBreakdown).toMatchObject({
      requirementCoverage: 0.855,
      scopeOwnershipAlignment: 1,
      domainContextAlignment: 1,
    });
    expect(assessed[0].evidenceRunId).toBe(
      fixture.workspace.intelligence.evidenceRun!.id,
    );
    expect(assessed[0].requirementMatches[0].evidence[0]).toMatchObject({
      claimId: citation.claimId,
      sourceVersionId: citation.sourceVersionId,
      locator: citation.locator,
      excerpt: citation.excerpt,
    });
    expect(callModels).toEqual([
      { callId: "match.requirements", model: "gpt-5.6-terra" },
      { callId: "match.verification", model: "gpt-5.6-luna" },
    ]);
  });

  it("runs matching v2 as one lean call without tier-2 or verifier stages", async () => {
    const fixture = await canonicalFixture();
    const job = opportunity(
      "job-ai",
      "AI Agent Infrastructure Engineer",
      "Requires TypeScript worker orchestration and verifier gates.",
    );
    const context = await loadPhase2EvidenceContext(
      fixture.root,
      fixture.workspace,
    );
    const citation = retrieveCanonicalClaimLedger(context!, [job])[0].evidence.find(
      (item) => item.capability === "agent control planes",
    )!;
    const callIds: string[] = [];
    let schemaRequired: readonly string[] = [];
    const codex = {
      start: async () => ({
        authenticated: true,
        model: "test-model",
        models: [{ id: "test-model" }],
      }),
      startThread: async ({ callId }: { callId: string }) => {
        callIds.push(callId);
        return { id: callId };
      },
      runTurn: async ({ outputSchema }: { outputSchema: { properties: { requirements: { items: { required: readonly string[] } } } } }) => {
        schemaRequired = outputSchema.properties.requirements.items.required;
        return {
          finalText: JSON.stringify({
            jobId: job.id,
            requirements: [
              {
                kind: "required",
                category: "mandatory",
                requirement: "TypeScript worker orchestration",
                status: "matched",
                matchClass: "explicit",
                confidence: 0.95,
                gapSeverity: "none",
                explanation: "The canonical claim directly supports the requirement.",
                evidence: [
                  {
                    claimId: citation.claimId,
                    sourceId: citation.sourceId,
                    excerpt: citation.excerpt,
                  },
                ],
              },
            ],
          }),
        };
      },
    } as unknown as CodexExecClient;

    const result = await matchOpportunities({
      codex,
      cwd: fixture.root,
      dataRoot: fixture.root,
      workspace: fixture.workspace,
      opportunities: [job],
      version: "v2",
    });

    expect(callIds).toEqual(["match.requirements"]);
    expect(schemaRequired).not.toContain("normalizedCapability");
    const assessed = Array.isArray(result) ? result : result.opportunities;
    expect(assessed[0].requirementMatches[0]).toMatchObject({
      matchClass: "explicit",
      status: "matched",
    });
  });

  it("does not allow a weak canonical claim to produce a full match", async () => {
    const fixture = await canonicalFixture("weakly_supported");
    const context = await loadPhase2EvidenceContext(
      fixture.root,
      fixture.workspace,
    );
    const job = opportunity(
      "job-ai",
      "AI Agent Infrastructure Engineer",
      "Requires TypeScript worker orchestration and verifier gates.",
    );
    const citation = retrieveCanonicalClaimLedger(context!, [job])[0].evidence.find(
      (item) => item.capability === "agent control planes",
    )!;
    const assessment = (status: "matched" | "partial") => ({
      jobId: "job-ai",
      requirements: [
        {
          kind: "required",
          requirement: "TypeScript worker orchestration",
          status,
          explanation: "The cited claim is relevant but is weakly supported.",
          evidence: [citation],
        },
      ],
    });
    const codex = {
      start: async () => ({
        authenticated: true,
        model: "test-model",
        models: [{ id: "test-model" }],
      }),
      startThread: async ({ role }: { role: string }) => ({ id: role }),
      runTurn: async ({ threadId }: { threadId: string }) => {
        if (threadId === "job-requirement-assessor")
          return { finalText: JSON.stringify(assessment("matched")) };
        if (threadId === "job-requirement-repairer")
          return { finalText: JSON.stringify(assessment("partial")) };
        return {
          finalText: JSON.stringify({
            jobId: "job-ai",
            verdict: "pass",
            findings: [],
            repairInstructions: [],
          }),
        };
      },
    } as unknown as CodexExecClient;
    const result = await new LiveOpportunityResearcher(
      codex,
      fixture.root,
      fixture.root,
    ).assess(fixture.workspace, [job]);
    const assessed = Array.isArray(result) ? result : result.opportunities;
    expect(assessed[0].requirementMatches[0].status).toBe("partial");
    expect(assessed[0].fit).toBe(46);
  });
});

async function canonicalFixture(
  aiSupport: "supported" | "weakly_supported" = "supported",
) {
  const root = await mkdtemp(path.join(tmpdir(), "rolegain-phase2-"));
  const content = [
    "Implemented a DeFi protocol with Solidity mechanism design.",
    "Built a TypeScript agent control plane with scoped workers and verifier gates.",
  ].join("\n");
  const source: CandidateSource = {
    id: "source-canonical",
    kind: "cv",
    name: "candidate.txt",
    content,
    status: "ready",
    insights: [
      {
        id: "noncanonical-1",
        title: "NONCANONICAL_INSIGHT_SHOULD_NOT_BE_USED",
        summary: "NONCANONICAL_INSIGHT_SHOULD_NOT_BE_USED",
        evidence: "NONCANONICAL_INSIGHT_SHOULD_NOT_BE_USED",
        skills: [],
        category: "other",
      },
    ],
    addedAt: "2026-07-16T12:00:00.000Z",
  };
  const workspace = workspaceFor(source);
  const analysis = analysisFor(workspace, aiSupport);
  const persisted = await persistCanonicalEvidenceRun({
    dataRoot: root,
    workspace,
    analysis,
  });
  workspace.intelligence.evidenceRun = {
    id: persisted.manifest.evidenceRunId,
    readyForSearch: persisted.manifest.readiness.readyForSearch,
    blockers: persisted.manifest.readiness.blockers,
    warnings: persisted.manifest.readiness.warnings,
    counts: persisted.manifest.readiness.counts,
  };
  return { root, workspace };
}

function workspaceFor(source: CandidateSource): JobSearchWorkspace {
  return {
    id: "candidate-phase2",
    candidateId: "candidate-phase2",
    phase: "search",
    profile: {
      name: "Candidate",
      email: "candidate@example.test",
      phone: "",
      linkedin: "",
      github: "",
      website: "",
      location: "Bratislava",
      headline: "Protocol and AI infrastructure engineer",
      summary: "LEGACY_PROFILE_SUMMARY_SHOULD_NOT_DRIVE_SEARCH",
      salaryExpectation: "",
      targetLocations: "",
      workplace: "Remote",
      employmentTypes: "Full-time",
      workAuthorization: "",
      startDate: "Immediately",
      skills: ["LEGACY_PROFILE_SKILL_SHOULD_NOT_DRIVE_SEARCH"],
      languages: ["English (Professional)"],
    },
    sources: [source],
    questions: [],
    opportunities: [],
    applications: [],
    rejectedOpportunities: [],
    searchValidationIssues: [],
    searchReadyOpportunities: [],
    jobHistory: [],
    seenJobUrls: [],
    searchConfig: { discoveryTarget: 20, applicationTarget: 5 },
    sharedAnswers: {},
    discoveryNeedsRun: true,
    profileCompleteness: 100,
    finalCv: source.content || "",
    intelligence: { status: "ready" },
    updatedAt: "2026-07-16T12:00:00.000Z",
  };
}

function analysisFor(
  workspace: JobSearchWorkspace,
  aiSupport: "supported" | "weakly_supported",
): CandidateAnalysisResult {
  const sourceId = workspace.sources[0].id;
  const claim = (
    action: string,
    capability: string,
    quote: string,
    toolsMethods: string[],
    supportStatus: "supported" | "weakly_supported" = "supported",
  ) => ({
    action,
    capability,
    workContexts: [],
    toolsMethods,
    credentials: [],
    ownership: "primary" as const,
    maturity: "implemented" as const,
    scope: "system" as const,
    startDate: "",
    endDate: "",
    outcomes: [],
    sourceEvidence: [{ sourceId, locator: "", quote }],
    supportStatus,
    confidence: 0.95,
    limitations: [],
  });
  return {
    threadId: "thread-phase2",
    profile: workspace.profile,
    sourceInsights: [
      {
        sourceId,
        insights: workspace.sources[0].insights,
        claims: [
          claim(
            "implemented a DeFi protocol",
            "protocol architecture",
            "Implemented a DeFi protocol with Solidity mechanism design.",
            ["Solidity", "mechanism design"],
          ),
          claim(
            "built a TypeScript agent control plane",
            "agent control planes",
            "Built a TypeScript agent control plane with scoped workers and verifier gates.",
            ["TypeScript", "scoped workers", "verifier gates"],
            aiSupport,
          ),
        ],
        unknowns: [],
        prohibitedInferences: [],
      },
    ],
    unknowns: [],
    contradictions: [],
    prohibitedInferences: [],
    roleFamilies: [
      {
        canonicalTitle: "Protocol Architect",
        titleAliases: ["DeFi Protocol Engineer"],
        problemPhrases: ["mechanism design"],
        leadingCapabilities: ["protocol architecture"],
        roleClass: "direct",
        geographyLanguageVariants: [],
        confidence: 0.95,
      },
      {
        canonicalTitle: "AI Agent Infrastructure Engineer",
        titleAliases: ["Agent Platform Engineer"],
        problemPhrases: ["worker orchestration"],
        leadingCapabilities: ["agent control planes"],
        roleClass: "adjacent",
        geographyLanguageVariants: [],
        confidence: 0.85,
      },
    ],
    searchVocabulary: {
      titleAliases: ["Protocol Architect", "AI Agent Infrastructure Engineer"],
      evidenceIntersections: ["DeFi mechanism design", "agent control planes"],
      problemPhrases: ["mechanism design", "worker orchestration"],
      toolsMethodsStandards: ["Solidity", "TypeScript", "verifier gates"],
      adjacentDialects: ["agent platform"],
      seniorityOwnershipModifiers: ["lead"],
      geographyLanguageVariants: ["Remote Europe"],
      negativeTerms: ["marketing"],
    },
  };
}

function opportunity(
  id: string,
  title: string,
  description: string,
): JobOpportunity {
  return {
    id,
    company: "Example",
    title,
    location: "Remote",
    workplace: "Remote",
    compensation: "",
    sourceUrl: `https://example.test/${id}`,
    applyUrl: `https://example.test/${id}/apply`,
    capturedAt: "2026-07-16",
    fit: 0,
    summary: description,
    description,
    requirements: [],
    requirementMatches: [],
    strengths: [],
    gaps: [],
  };
}
