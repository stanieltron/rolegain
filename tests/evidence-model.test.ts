import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CandidateAnalysisResult } from "../src/01-evidence-ingestion/types.js";
import type {
  CandidateSource,
  JobSearchWorkspace,
} from "../src/contracts/job-search.js";
import {
  persistCanonicalEvidenceRun,
  readCurrentEvidenceModel,
} from "../src/01-evidence-ingestion/04-verification/evidence-model.js";
import type { EvidenceClaim } from "../src/contracts/evidence.js";

describe("canonical phase-one evidence", () => {
  it("creates source snapshots only while publishing an audited model", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-evidence-model-"));
    const candidateId = "candidate-1";
    const cv = source(
      "cv-1",
      "cv",
      "candidate.pdf",
      "Stan Candidate\nImplemented durable workflow recovery for failed jobs.\nMeasured a 40% reduction in manual recovery time.",
    );
    const portfolio = source(
      "site-1",
      "portfolio",
      "Portfolio",
      "Case study\nImplemented durable workflow recovery for failed jobs.\nDesigned idempotent checkpoints and bounded repair.",
      "https://example.test/work",
    );
    const snapshotRoot = path.join(
      root,
      "job-search",
      "source-snapshots",
      candidateId,
    );
    const workspace = workspaceFor(candidateId, [cv, portfolio]);
    const analysis = analysisFor(workspace);
    const persisted = await persistCanonicalEvidenceRun({
      dataRoot: root,
      workspace,
      analysis,
    });
    expect(persisted.manifest.readiness.readyForSearch).toBe(true);
    expect(await readdir(snapshotRoot)).toEqual([
      `source-${portfolio.contentHash!.slice(0, 20)}`,
    ]);
    expect(persisted.manifest.readiness.counts).toMatchObject({
      sources: 2,
      claims: 1,
      supportedClaims: 1,
      capabilities: 1,
      roleFamilies: 2,
    });

    const model = await readCurrentEvidenceModel(root, candidateId);
    const claims = model.claims as EvidenceClaim[];
    expect(claims).toHaveLength(1);
    expect(claims[0].sourceRefs).toHaveLength(2);
    expect(claims[0].sourceRefs.map((ref) => ref.locator)).toEqual([
      "page 1, lines 2-2",
      "https://example.test/work; lines 2-2",
    ]);
    expect(claims[0].sourceRefs.every((ref) => ref.quoteHash.length === 64)).toBe(true);
    expect(model.capabilities).toEqual([
      expect.objectContaining({
        name: "workflow orchestration",
        evidenceStrength: expect.any(Number),
      }),
    ]);
    expect(model.roleFamilies).toEqual([
      expect.objectContaining({ roleClass: "direct" }),
      expect.objectContaining({ roleClass: "adjacent" }),
    ]);

    analysis.searchVocabulary!.titleAliases.push("Distributed Systems Engineer");
    const revised = await persistCanonicalEvidenceRun({
      dataRoot: root,
      workspace,
      analysis,
    });
    expect(revised.manifest.evidenceRunId).not.toBe(
      persisted.manifest.evidenceRunId,
    );
  });

  it("does not declare search readiness when positive claims lack exact citations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-evidence-blocked-"));
    const candidateId = "candidate-2";
    const cv = source(
      "cv-2",
      "cv",
      "candidate.txt",
      "Candidate built a TypeScript service.",
    );
    const workspace = workspaceFor(candidateId, [cv]);
    const analysis = analysisFor(workspace);
    analysis.sourceInsights[0].claims![0].sourceEvidence[0].quote =
      "This quote does not exist in the source";
    analysis.sourceInsights = [analysis.sourceInsights[0]];
    analysis.roleFamilies = analysis.roleFamilies?.slice(0, 1);
    const persisted = await persistCanonicalEvidenceRun({
      dataRoot: root,
      workspace,
      analysis,
    });
    expect(persisted.manifest.readiness.readyForSearch).toBe(false);
    expect(persisted.manifest.readiness.blockers).toContain(
      "No positive claim has an exact supported source reference",
    );
    const claims = JSON.parse(
      (await readFile(path.join(persisted.directory, "claims.jsonl"), "utf8")).trim(),
    ) as EvidenceClaim;
    expect(claims.supportStatus).toBe("weakly_supported");
  });

  it("audits insight-derived claims as supported only when their quote is exact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-evidence-compat-"));
    const candidateId = "candidate-compat";
    const cv = source(
      "cv-compat",
      "cv",
      "candidate.txt",
      "Candidate built a TypeScript service.\nImplemented durable workflow recovery for failed jobs.",
    );
    const workspace = workspaceFor(candidateId, [cv]);
    const analysis = analysisFor(workspace);
    delete analysis.sourceInsights[0].claims;
    analysis.roleFamilies = analysis.roleFamilies?.slice(0, 1);

    const exact = await persistCanonicalEvidenceRun({
      dataRoot: root,
      workspace,
      analysis,
    });
    const exactClaim = JSON.parse(
      (await readFile(path.join(exact.directory, "claims.jsonl"), "utf8")).trim(),
    ) as EvidenceClaim;
    expect(exactClaim.supportStatus).toBe("supported");
    expect(exact.manifest.readiness.counts.supportedClaims).toBe(1);

    workspace.sources[0].insights[0].evidence = "Quote absent from the source";
    const inexact = await persistCanonicalEvidenceRun({
      dataRoot: root,
      workspace,
      analysis,
    });
    const inexactClaim = JSON.parse(
      (await readFile(path.join(inexact.directory, "claims.jsonl"), "utf8")).trim(),
    ) as EvidenceClaim;
    expect(inexactClaim.supportStatus).toBe("weakly_supported");
  });
});

function source(
  id: string,
  kind: CandidateSource["kind"],
  name: string,
  content: string,
  url?: string,
): CandidateSource {
  const hash = createHash("sha256").update(content).digest("hex");
  return {
    id,
    kind,
    name,
    url,
    content,
    contentHash: kind === "cv" ? undefined : hash,
    status: "ready",
    insights: [
      {
        id: `insight-${id}`,
        title: "Workflow orchestration",
        summary: "Implemented durable workflow recovery.",
        evidence: "Implemented durable workflow recovery for failed jobs.",
        skills: ["workflow orchestration"],
        category: "project",
      },
    ],
    addedAt: "2026-07-16T12:00:00.000Z",
  };
}

function workspaceFor(
  candidateId: string,
  sources: CandidateSource[],
): JobSearchWorkspace {
  return {
    id: candidateId,
    candidateId,
    phase: "intake",
    profile: {
      name: "Stan Candidate",
      email: "stan@example.test",
      phone: "",
      linkedin: "",
      github: "",
      website: "",
      location: "Bratislava",
      headline: "Platform engineer",
      summary: "Builds reliable workflow systems.",
      salaryExpectation: "",
      targetLocations: "",
      workplace: "Remote",
      employmentTypes: "Full-time",
      workAuthorization: "",
      startDate: "Immediately",
      skills: ["workflow orchestration"],
      languages: ["English (Professional)"],
    },
    sources,
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
    profileCompleteness: 50,
    finalCv: sources.find((item) => item.kind === "cv")?.content || "",
    intelligence: { status: "ready" },
    updatedAt: "2026-07-16T12:00:00.000Z",
  };
}

function analysisFor(workspace: JobSearchWorkspace): CandidateAnalysisResult {
  const claim = (sourceId: string) => ({
    action: "implemented durable workflow recovery for failed jobs",
    capability: "workflow orchestration",
    workContexts: ["job processing"],
    toolsMethods: ["idempotent checkpoints"],
    credentials: [],
    ownership: "primary" as const,
    maturity: "implemented" as const,
    scope: "system" as const,
    startDate: "",
    endDate: "",
    outcomes: [],
    sourceEvidence: [
      {
        sourceId,
        locator: "lines 2-2",
        quote: "Implemented durable workflow recovery for failed jobs.",
      },
    ],
    supportStatus: "supported" as const,
    confidence: 0.94,
    limitations: ["Production scale is not established"],
  });
  return {
    threadId: "thread-evidence",
    profile: workspace.profile,
    sourceInsights: workspace.sources.map((item) => ({
      sourceId: item.id,
      insights: item.insights,
      knowledgeMarkdown: `# ${item.name}`,
      claims: [claim(item.id)],
      unknowns: [],
      prohibitedInferences: [],
    })),
    unknowns: [],
    contradictions: [],
    prohibitedInferences: [],
    roleFamilies: [
      {
        canonicalTitle: "Platform Engineer",
        titleAliases: ["Workflow Platform Engineer"],
        problemPhrases: ["reliable workflow execution"],
        leadingCapabilities: ["workflow orchestration"],
        roleClass: "direct",
        geographyLanguageVariants: [],
        confidence: 0.91,
      },
      {
        canonicalTitle: "Reliability Engineer",
        titleAliases: ["Systems Reliability Engineer"],
        problemPhrases: ["failure recovery"],
        leadingCapabilities: ["workflow orchestration"],
        roleClass: "adjacent",
        geographyLanguageVariants: [],
        confidence: 0.7,
      },
    ],
    searchVocabulary: {
      titleAliases: ["Platform Engineer"],
      evidenceIntersections: ["workflow recovery idempotent checkpoints"],
      problemPhrases: ["reliable workflow execution"],
      toolsMethodsStandards: ["idempotent checkpoints"],
      adjacentDialects: ["durable execution"],
      seniorityOwnershipModifiers: ["lead"],
      geographyLanguageVariants: ["remote Europe"],
      negativeTerms: [],
    },
  };
}
