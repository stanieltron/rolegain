import { readFile } from "node:fs/promises";
import path from "node:path";
import { persistCanonicalEvidenceRun } from "../../../../src/01-evidence-ingestion/04-verification/evidence-model.js";
import type { CandidateAnalysisResult } from "../../../../src/01-evidence-ingestion/types.js";
import type {
  CandidateProfile,
  CandidateSource,
  JobOpportunity,
  JobSearchWorkspace,
} from "../../../../src/contracts/job-search.js";
import type { EvidenceClaim } from "../../../../src/contracts/evidence.js";
import {
  loadPhase2EvidenceContext,
  retrieveCanonicalClaimLedger,
} from "../../../../src/search-match-shared/evidence-context.js";
import type {
  MatchEvalClaim,
  MatchRequirementsEvalCase,
  PreparedMatchEvalCase,
} from "./types.js";

export async function prepareMatchEvalCase(
  testCase: MatchRequirementsEvalCase,
  dataRoot: string,
): Promise<PreparedMatchEvalCase> {
  const source = sourceFor(testCase);
  const workspace = workspaceFor(testCase, source);
  const analysis = analysisFor(testCase, workspace, source);
  const persisted = await persistCanonicalEvidenceRun({
    dataRoot,
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
  const claims = await readJsonl<EvidenceClaim>(
    path.join(persisted.directory, "claims.jsonl"),
  );
  const claimIdByKey = Object.fromEntries(
    testCase.claims.map((claim) => {
      const persistedClaim = claims.find((item) =>
        item.sourceRefs.some((ref) => ref.quote === claim.quote),
      );
      if (!persistedClaim)
        throw new Error(`${testCase.id}: persisted claim missing for ${claim.key}`);
      return [claim.key, persistedClaim.claimId];
    }),
  );
  const opportunity = opportunityFor(testCase);
  const context = await loadPhase2EvidenceContext(dataRoot, workspace);
  if (!context) throw new Error(`${testCase.id}: canonical context was not persisted`);
  const sourceLedger = retrieveCanonicalClaimLedger(context, [opportunity], 80)
    .flatMap((packet) => packet.evidence);
  return { testCase, workspace, opportunity, sourceLedger, claimIdByKey };
}

function sourceFor(testCase: MatchRequirementsEvalCase): CandidateSource {
  return {
    id: `source-${testCase.id}`,
    kind: "cv",
    name: `${testCase.id}.txt`,
    content: testCase.claims.map((claim) => claim.quote).join("\n"),
    status: "ready",
    insights: [],
    addedAt: "2026-07-22T00:00:00.000Z",
  };
}

function workspaceFor(
  testCase: MatchRequirementsEvalCase,
  source: CandidateSource,
): JobSearchWorkspace {
  const profile: CandidateProfile = {
    name: "Eval Candidate",
    email: "candidate@example.test",
    phone: "",
    linkedin: "",
    github: "",
    website: "",
    location: "Bratislava, Slovakia",
    headline: testCase.title,
    summary: "",
    salaryExpectation: "",
    targetLocations: "Europe",
    workplace: "Remote",
    employmentTypes: "Full-time",
    workAuthorization: "",
    startDate: "",
    skills: [],
    languages: [],
  };
  return {
    id: `eval-${testCase.id}`,
    candidateId: `eval-${testCase.id}`,
    phase: "search",
    profile,
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
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
}

function analysisFor(
  testCase: MatchRequirementsEvalCase,
  workspace: JobSearchWorkspace,
  source: CandidateSource,
): CandidateAnalysisResult {
  const claimByKey = new Map(testCase.claims.map((claim) => [claim.key, claim]));
  return {
    threadId: `eval-fixture-${testCase.id}`,
    profile: workspace.profile,
    sourceInsights: [
      {
        sourceId: source.id,
        insights: [],
        claims: testCase.claims.map((claim) => claimDraft(claim, source.id)),
        unknowns: [],
        prohibitedInferences: (testCase.prohibitedInferences || []).map((item) => ({
          rule: item.rule,
          reason: item.reason,
          sourceIds: item.claimKeys.map((key) => {
            if (!claimByKey.has(key))
              throw new Error(`${testCase.id}: unknown prohibited claim key ${key}`);
            return source.id;
          }),
        })),
      },
    ],
    unknowns: [],
    contradictions: (testCase.contradictions || []).map((item) => ({
      field: item.field,
      values: item.values.map((value) => ({
        value: value.value,
        sourceId: source.id,
        quote: claimByKey.get(value.claimKey)?.quote || "",
      })),
      explanation: item.explanation,
    })),
    prohibitedInferences: [],
    roleFamilies: [
      {
        canonicalTitle: testCase.title,
        titleAliases: [],
        problemPhrases: testCase.responsibilities,
        leadingCapabilities: testCase.claims.map((claim) => claim.capability),
        roleClass: "direct",
        geographyLanguageVariants: [],
        confidence: 0.9,
      },
      {
        canonicalTitle: `${testCase.title} Adjacent`,
        titleAliases: [],
        problemPhrases: [],
        leadingCapabilities: testCase.claims.map((claim) => claim.capability),
        roleClass: "adjacent",
        geographyLanguageVariants: [],
        confidence: 0.6,
      },
    ],
    searchVocabulary: {
      titleAliases: [testCase.title],
      evidenceIntersections: testCase.claims.map((claim) => claim.capability),
      problemPhrases: testCase.responsibilities,
      toolsMethodsStandards: testCase.claims.flatMap(
        (claim) => claim.toolsMethods || [],
      ),
      adjacentDialects: [],
      seniorityOwnershipModifiers: [],
      geographyLanguageVariants: [],
      negativeTerms: [],
    },
  };
}

function claimDraft(claim: MatchEvalClaim, sourceId: string) {
  return {
    action: claim.action,
    capability: claim.capability,
    workContexts: claim.workContexts || [],
    toolsMethods: claim.toolsMethods || [],
    credentials: claim.credentials || [],
    ownership: claim.ownership || ("primary" as const),
    maturity: claim.maturity || ("implemented" as const),
    scope: claim.scope || ("system" as const),
    startDate: claim.startDate || "",
    endDate: claim.endDate || "",
    outcomes: [],
    sourceEvidence: [{ sourceId, locator: "", quote: claim.quote }],
    supportStatus: claim.supportStatus || ("supported" as const),
    confidence: claim.confidence ?? 0.95,
    limitations: claim.limitations || [],
  };
}

function opportunityFor(testCase: MatchRequirementsEvalCase): JobOpportunity {
  const description = [
    "Core Responsibilities:",
    ...testCase.responsibilities.map((value) => `- ${value}`),
    "Requirements:",
    ...testCase.qualifications.map((value) => `- ${value}`),
    "About the company: Synthetic evaluation employer.",
  ].join("\n");
  return {
    id: `job-${testCase.id}`,
    company: "Eval Employer",
    title: testCase.title,
    location: "Remote Europe",
    workplace: "Remote",
    compensation: "",
    sourceUrl: `https://example.test/jobs/${testCase.id}`,
    applyUrl: `https://example.test/jobs/${testCase.id}/apply`,
    capturedAt: "2026-07-22T00:00:00.000Z",
    fit: 0,
    summary: description,
    description,
    requirements: [],
    requirementMatches: [],
    strengths: [],
    gaps: [],
    opportunityConfidence: 0.95,
  };
}

async function readJsonl<T>(file: string): Promise<T[]> {
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

