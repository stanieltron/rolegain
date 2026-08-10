import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobOpportunity, JobResearchFailure, JobSearchWorkspace, RequirementMatch } from "../../../contracts/job-search.js";
import type { CodexExecClient } from "../../../codex-runtime/client.js";
import { productionModel } from "../../../codex-runtime/call-manifest.js";
import { ResultGatewayError } from "../../../codex-runtime/result-gateway.js";
import {
  buildInput as buildRequirementMatchingInput,
  buildRecoveryInput as buildRequirementRecoveryInput,
  command as REQUIREMENT_MATCHING_COMMAND,
  outputSchema as opportunityAssessmentsSchema,
  rolePrompt as REQUIREMENT_MATCHING_ROLE_PROMPT,
  type AgentRequirementAssessment,
  type RequirementAssessmentOutput,
} from "./llm-calls/01-requirement-matching/index.js";
import {
  buildInput as buildTier2MatchingInput,
  command as TIER2_MATCHING_COMMAND,
  outputSchema as tier2AssessmentsSchema,
  rolePrompt as TIER2_MATCHING_ROLE_PROMPT,
} from "./llm-calls/02-tier2-matching/index.js";
import {
  buildInput as buildMatchRepairInput,
  buildRecoveryInput as buildMatchRepairRecoveryInput,
  command as MATCH_REPAIR_COMMAND,
  outputSchema as matchRepairSchema,
  rolePrompt as MATCH_REPAIR_ROLE_PROMPT,
} from "./llm-calls/04-match-repair/index.js";
import { runMatchVerificationCall } from "./run-match-verification.js";
import {
  canonicalCitationIsValid,
  loadPhase2EvidenceContext,
  retrieveCanonicalClaimLedger,
  retrieveKnowledgeRoutes,
  selectKnowledgeExcerpt,
  type CanonicalClaimCitation,
  type Phase2EvidenceContext,
} from "../../../search-match-shared/evidence-context.js";
import {
  extractQualificationSection,
  extractResponsibilitiesSection,
  failureFromOpportunity,
} from "../../../search-match-shared/opportunity.js";
import { mapParallelOrdered, matchingConcurrency } from "../../../search-match-shared/parallel.js";
import { progressItemFromOpportunity } from "../../../search-match-shared/progress.js";
import type { OpportunityProgressReporter } from "../../../search-match-shared/types.js";
import type { MatchVersion } from "../../../config/runtime.js";
import {
  leanRequirementOutputSchema,
  leanRequirementRolePrompt,
} from "../../v2/contract.js";

export async function matchOpportunities(input: {
  codex?: CodexExecClient;
  cwd: string;
  dataRoot: string;
  workspace: JobSearchWorkspace;
  opportunities: JobOpportunity[];
  onProgress?: OpportunityProgressReporter;
  version?: MatchVersion;
}) {
  const { codex, cwd, dataRoot, workspace, opportunities, onProgress, version } = input;
  if (!codex) return opportunities;
  const results = await mapParallelOrdered(
    opportunities,
    matchingConcurrency(),
    async (opportunity) => {
      await onProgress?.({
        item: progressItemFromOpportunity(opportunity),
        phase: "match",
        state: "running",
      });
      try {
        return await assessOpportunityWithAgent(
          codex,
          cwd,
          dataRoot,
          workspace,
          opportunity,
          undefined,
          version,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await onProgress?.({
          item: progressItemFromOpportunity(opportunity),
          phase: "match",
          state: "failed",
          reason,
        });
        return {
          opportunities: [],
          failures: [failureFromOpportunity(opportunity, "requirements", reason)],
        };
      }
    },
  );
  const result = {
    opportunities: results.flatMap((item) => item.opportunities),
    failures: results.flatMap((item) => item.failures),
  };
  await Promise.all(
    result.opportunities.map((job) =>
      onProgress?.({
        item: progressItemFromOpportunity(job),
        phase: "match",
        state: "passed",
        fit: job.fit,
        activity: `${job.company} · ${job.title}: assessed ${job.requirementMatches.length} employer requirements, retained ${job.strengths.length} evidence-backed strengths and ${job.gaps.length} visible gaps; final fit ${job.fit}%.`,
      }),
    ),
  );
  return result;
}

export type { AgentRequirementAssessment } from "./llm-calls/01-requirement-matching/index.js";

export async function assessOpportunityWithAgent(
  codex: CodexExecClient,
  cwd: string,
  dataRoot: string,
  workspace: JobSearchWorkspace,
  opportunity: JobOpportunity,
  modelOverride?: string,
  version: MatchVersion = process.env.ROLEGAIN_MATCH_VERSION === "v2"
    ? "v2"
    : "v1",
): Promise<{
  opportunities: JobOpportunity[];
  failures: JobResearchFailure[];
}> {
  const opportunities = [opportunity];
  const runtime = await codex.start();
  if (!runtime.authenticated)
    throw new Error("Codex is not authenticated for requirement matching");
  const model =
    modelOverride ??
    productionModel(REQUIREMENT_MATCHING_COMMAND, runtime.model);
  const useV2 = version === "v2";
  const thread = await codex.startThread({
    cwd,
    callId: "match.requirements",
    role: REQUIREMENT_MATCHING_COMMAND.role,
    sandbox: "read-only",
    model,
    approvalPolicy: REQUIREMENT_MATCHING_COMMAND.approvalPolicy,
    developerInstructions: useV2
      ? leanRequirementRolePrompt
      : REQUIREMENT_MATCHING_ROLE_PROMPT,
  });
  const phase2Evidence = await loadPhase2EvidenceContext(dataRoot, workspace);
  if (!phase2Evidence)
    throw new Error(
      "A canonical evidence run is required before requirement matching",
    );
  const canonicalPackets = retrieveCanonicalClaimLedger(
    phase2Evidence,
    opportunities,
  );
  const sourceLedger = uniqueCanonicalCitations(
    canonicalPackets.flatMap((packet) => packet.evidence),
  );
  const assessmentEvidence = {
    evidenceRunId: phase2Evidence.evidenceRunId,
    evidenceByJob: canonicalPackets,
    knowledgeRoutesByJob: retrieveKnowledgeRoutes(
      phase2Evidence,
      opportunities,
    ),
    materialUnknowns: phase2Evidence.unknowns.filter(
      (unknown) => unknown.materiality !== "low",
    ),
    contradictions: phase2Evidence.contradictions,
    prohibitedInferences: phase2Evidence.prohibitedInferences,
  };
  const result = await codex.runTurn({
    threadId: thread.id,
    prompt: buildRequirementMatchingInput({
      assessmentEvidence,
      opportunities,
    }),
    cwd,
    sandbox: REQUIREMENT_MATCHING_COMMAND.sandbox,
    outputSchema: useV2
      ? leanRequirementOutputSchema
      : opportunityAssessmentsSchema,
    model,
    approvalPolicy: REQUIREMENT_MATCHING_COMMAND.approvalPolicy,
    effort: useV2 ? "low" : REQUIREMENT_MATCHING_COMMAND.effort,
    timeoutMs: REQUIREMENT_MATCHING_COMMAND.timeoutMs,
  });
  let assessment = JSON.parse(result.finalText) as RequirementAssessmentOutput;
  assertAssessmentJobId(assessment, opportunity.id, "match.requirements");
  if (!assessment.requirements.length) {
    const retry = await codex.runTurn({
      threadId: thread.id,
      prompt: buildRequirementRecoveryInput([opportunity]),
      cwd,
      sandbox: REQUIREMENT_MATCHING_COMMAND.sandbox,
      outputSchema: useV2
        ? leanRequirementOutputSchema
        : opportunityAssessmentsSchema,
      model,
      approvalPolicy: REQUIREMENT_MATCHING_COMMAND.approvalPolicy,
      effort: useV2 ? "low" : REQUIREMENT_MATCHING_COMMAND.effort,
      timeoutMs: REQUIREMENT_MATCHING_COMMAND.timeoutMs,
    });
    assessment = JSON.parse(retry.finalText) as RequirementAssessmentOutput;
    assertAssessmentJobId(assessment, opportunity.id, "match.requirements");
  }
  const escalated = useV2
    ? { assessments: [assessment], documents: [] as Tier2MatchingDocument[] }
    : await escalateUnresolvedRequirements(
        codex,
        cwd,
        modelOverride,
        opportunities,
        [assessment],
        phase2Evidence,
      );
  assessment = escalated.assessments[0] || assessment;
  const verificationLedger = uniqueCanonicalCitations([
    ...sourceLedger,
    ...escalated.documents.flatMap((document) => document.citations || []),
  ]);
  const verified = useV2
    ? {
        assessments: [assessment],
        reviews: [] as Awaited<ReturnType<typeof verifyAssessments>>,
        rejected: [] as Array<{
          jobId: string;
          findings: Array<{ message: string }>;
        }>,
      }
    : await verifyAndRepairAssessments(
        codex,
        cwd,
        modelOverride,
        verificationLedger,
        opportunities,
        [assessment],
      );
  const verifiedAssessments = verified.assessments;
  const sourcesById = new Map(
    workspace.sources.map((source) => [source.id, source.name]),
  );
  const assessmentByJobId = new Map(
    verifiedAssessments.map((item) => [item.jobId, item]),
  );
  const canonicalVerificationLedger = verificationLedger;
  const assessedOpportunities = opportunities.flatMap((opportunity) => {
    const assessment = assessmentByJobId.get(opportunity.id);
    if (!assessment?.requirements.length) return [];
    const requirementMatches = assessment.requirements.map((item, index) => {
      const evidence = item.evidence
        .filter(
          (entry) =>
            sourcesById.has(entry.sourceId) &&
            entry.excerpt.trim() &&
            canonicalCitationIsValid(canonicalVerificationLedger, entry),
        )
        .map((entry) => {
          const canonical = canonicalVerificationLedger.find(
            (citation) =>
              citation.claimId === entry.claimId &&
              citation.sourceId === entry.sourceId &&
              canonicalCitationIsValid(canonicalVerificationLedger, entry),
          );
          return {
            claimId: entry.claimId,
            sourceId: entry.sourceId,
            sourceName: sourcesById.get(entry.sourceId)!,
            sourceVersionId: canonical?.sourceVersionId,
            locator: canonical?.locator || entry.locator,
            excerpt: entry.excerpt.trim(),
            claimConfidence: canonical?.confidence,
          };
        });
      const category = normalizedRequirementCategory(item);
      let matchClass = normalizedMatchClass(item);
      let status = statusForMatchClass(matchClass);
      if (item.status === "missing" || evidence.length === 0) {
        status = "missing";
        if (matchClass !== "contradicted") matchClass = "unsupported";
      }
      if (
        status === "matched" &&
        evidence.some((entry) =>
          canonicalVerificationLedger.some(
            (citation) =>
              citation.claimId === entry.claimId &&
              citation.sourceId === entry.sourceId &&
              citation.supportStatus !== "supported",
          ),
        )
      )
        {
          status = "partial";
          matchClass = "weak_adjacent";
        }
      const confidence = clamp01(
        item.confidence ??
          (matchClass === "explicit"
            ? 0.9
            : matchClass === "strong_adjacent"
              ? 0.75
              : matchClass === "weak_adjacent"
                ? 0.55
                : 1),
      );
      return {
        id: `${opportunity.id}-requirement-${index + 1}`,
        kind: category === "preferred" ? "preferred" : "required",
        category,
        requirement: item.requirement.trim(),
        status,
        matchClass,
        confidence,
        importanceWeight: requirementWeight(category),
        credit: matchCredit(matchClass),
        gapClass:
          item.gapClass || (matchClass === "explicit" ? "none" : "evidence_quality"),
        gapSeverity:
          item.gapSeverity ||
          (matchClass === "explicit"
            ? "none"
            : matchClass === "strong_adjacent"
              ? "learnable"
              : matchClass === "contradicted"
                ? "blocking"
                : "substantial"),
        normalizedCapability: item.normalizedCapability || "",
        minimumDuration: Math.max(0, item.minimumDuration || 0),
        requiredOwnership: item.requiredOwnership || "",
        requiredMaturity: item.requiredMaturity || "",
        requiredScope: item.requiredScope || "",
        requiredWorkContext: item.requiredWorkContext || "",
        requiredToolMethod: item.requiredToolMethod || "",
        requiredCredential: item.requiredCredential || "",
        ambiguityFlags: item.ambiguityFlags || [],
        sourceLocator: item.sourceLocator || "",
        explanation:
          status === "missing"
            ? "No evidence found in the supplied candidate sources."
            : item.explanation.trim(),
        evidence:
          status === "missing" && matchClass !== "contradicted" ? [] : evidence,
      } satisfies RequirementMatch;
    });
    const score = calculateRequirementScore(
      requirementMatches,
      canonicalVerificationLedger,
    );
    const feasibilityGate = evaluateFeasibilityGate(
      workspace,
      opportunity,
      requirementMatches,
    );
    const review = verified.reviews.find((item) => item.jobId === opportunity.id);
    const portfolioCategory = phase2PortfolioCategory(
      score.final,
      requirementMatches,
      feasibilityGate.status,
      opportunity.opportunityConfidence ?? 0,
    );
    return [{
      ...opportunity,
      evidenceRunId: phase2Evidence.evidenceRunId,
      fit: score.final,
      scoreBreakdown: score,
      feasibilityGate,
      portfolioCategory,
      skepticalReview: {
        acceptedScore: score.final,
        revisedScore: score.final,
        inflationFlags: review?.inflationFlags || [],
        feasibilityFlags: [
          ...(review?.feasibilityFlags || []),
          ...feasibilityGate.reasons,
        ],
        statusConfidence: clamp01(
          review?.statusConfidence ?? opportunity.opportunityConfidence ?? 0.5,
        ),
        decision:
          portfolioCategory === "rejected"
            ? "rejected"
            : review?.decision || "accepted",
        rationale:
          review?.rationale ||
          "Independent verification accepted the evidence matrix after deterministic citation and section checks.",
      },
      requirements: requirementMatches.map((item) => item.requirement),
      requirementMatches,
      strengths: requirementMatches
        .filter((item) => item.status === "matched")
        .map((item) => item.requirement),
      gaps: requirementMatches
        .filter((item) => item.status === "missing")
        .map((item) => item.requirement),
    }];
  });
  await Promise.all(
    assessedOpportunities.map((opportunity) =>
      persistPhase2MatchAudit(dataRoot, workspace.candidateId, opportunity),
    ),
  );
  return {
    opportunities: assessedOpportunities,
    failures: verified.rejected.map((item) => {
      const job = opportunities.find((opportunity) => opportunity.id === item.jobId)!;
      return failureFromOpportunity(
        job,
        "requirements",
        item.findings.map((finding) => finding.message).join("; ") ||
          "Requirement verification failed after one bounded repair",
      );
    }),
  };
}

export async function persistPhase2MatchAudit(
  dataRoot: string,
  candidateId: string,
  opportunity: JobOpportunity,
) {
  if (!opportunity.searchRunId) return;
  const root = path.join(
    dataRoot,
    "job-search",
    "runs",
    candidateId,
    "search-runs",
    opportunity.searchRunId,
    "matches",
  );
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, `${opportunity.id.replace(/[^a-z0-9._-]+/gi, "-")}.json`),
    JSON.stringify(
      {
        searchRunId: opportunity.searchRunId,
        evidenceRunId: opportunity.evidenceRunId,
        jobId: opportunity.id,
        fit: opportunity.fit,
        opportunityConfidence: opportunity.opportunityConfidence,
        feasibilityGate: opportunity.feasibilityGate,
        scoreBreakdown: opportunity.scoreBreakdown,
        requirements: opportunity.requirementMatches,
        skepticalReview: opportunity.skepticalReview,
        portfolioCategory: opportunity.portfolioCategory,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export interface Tier2MatchingDocument {
  sourceId: string;
  sourceName: string;
  detailRef: string;
  content: string;
  citations?: CanonicalClaimCitation[];
}

export async function escalateUnresolvedRequirements(
  codex: CodexExecClient,
  cwd: string,
  model: string | undefined,
  opportunities: JobOpportunity[],
  assessments: AgentRequirementAssessment[],
  phase2Evidence: Phase2EvidenceContext,
) {
  const unresolved = assessments.flatMap((assessment) =>
    assessment.requirements
      .filter((requirement) => requirement.status !== "matched")
      .map((requirement) => ({ jobId: assessment.jobId, ...requirement })),
  );
  if (unresolved.length === 0)
    return { assessments, documents: [] as Tier2MatchingDocument[] };
  const documents = await loadTier2MatchingDocuments(
    opportunities,
    assessments,
    phase2Evidence,
  );
  if (documents.length === 0) return { assessments, documents };
  const tier2Model = model ?? productionModel(TIER2_MATCHING_COMMAND);

  const thread = await codex.startThread({
    cwd,
    callId: "match.tier2-evidence",
    role: TIER2_MATCHING_COMMAND.role,
    sandbox: "read-only",
    model: tier2Model,
    approvalPolicy: TIER2_MATCHING_COMMAND.approvalPolicy,
    developerInstructions: TIER2_MATCHING_ROLE_PROMPT,
  });
  const result = await codex.runTurn({
    threadId: thread.id,
    cwd,
    sandbox: TIER2_MATCHING_COMMAND.sandbox,
    outputSchema: tier2AssessmentsSchema,
    model: tier2Model,
    effort: TIER2_MATCHING_COMMAND.effort,
    timeoutMs: TIER2_MATCHING_COMMAND.timeoutMs,
    prompt: buildTier2MatchingInput({ unresolved, documents }),
  });
  const tier2Assessment = JSON.parse(
    result.finalText,
  ) as RequirementAssessmentOutput;
  const expectedJobIds = [...new Set(unresolved.map((item) => item.jobId))];
  if (expectedJobIds.length !== 1)
    throw new Error(
      `Tier-2 matching is one-job-per-call; received ${expectedJobIds.length} job ids`,
    );
  assertAssessmentJobId(
    tier2Assessment,
    expectedJobIds[0],
    "match.tier2-evidence",
  );
  const tier2 = [tier2Assessment];
  const allowedSourceIds = new Set(documents.map((document) => document.sourceId));
  const canonicalCitations = documents.flatMap(
    (document) => document.citations || [],
  );
  for (const assessment of tier2)
    for (const requirement of assessment.requirements) {
      requirement.evidence = requirement.evidence.filter(
        (evidence) =>
          allowedSourceIds.has(evidence.sourceId) &&
          evidence.excerpt.trim() &&
          canonicalCitationIsValid(canonicalCitations, evidence),
      );
      if (requirement.status !== "missing" && requirement.evidence.length === 0) {
        requirement.status = "missing";
        requirement.explanation =
          "No supporting evidence was found in the selected detailed source notes.";
      }
      if (requirement.status === "missing") requirement.evidence = [];
      if (
        requirement.status === "matched" &&
        requirement.evidence.some((evidence) =>
          canonicalCitations.some(
            (citation) =>
              citation.claimId === evidence.claimId &&
              citation.sourceId === evidence.sourceId &&
              citation.supportStatus !== "supported",
          ),
        )
      )
        requirement.status = "partial";
      enforceTier2ScaleGrounding(requirement, documents);
    }
  return {
    assessments: mergeTier2Assessments(assessments, tier2),
    documents,
  };
}

export async function loadTier2MatchingDocuments(
  opportunities: JobOpportunity[],
  assessments: AgentRequirementAssessment[],
  phase2Evidence: Phase2EvidenceContext,
): Promise<Tier2MatchingDocument[]> {
  const assessmentsById = new Map(
    assessments.map((assessment) => [assessment.jobId, assessment]),
  );
  const retrievalJobs = opportunities.map((job) => ({
    ...job,
    description: `${job.description || job.summary}\n${(
      assessmentsById.get(job.id)?.requirements || []
    )
      .filter((requirement) => requirement.status !== "matched")
      .map((requirement) => requirement.requirement)
      .join("\n")}`,
  }));
  const citations = retrieveCanonicalClaimLedger(
    phase2Evidence,
    retrievalJobs,
    80,
  ).flatMap((packet) => packet.evidence);
  const knowledgeRoutes = retrieveKnowledgeRoutes(
    phase2Evidence,
    retrievalJobs,
    4,
  ).flatMap((packet) => packet.pages);
  const bySource = new Map<string, CanonicalClaimCitation[]>();
  for (const citation of citations)
    bySource.set(citation.sourceId, [
      ...(bySource.get(citation.sourceId) || []),
      citation,
    ]);
  const unresolvedText = retrievalJobs
    .map(
      (job) =>
        `${job.title}\n${job.summary}\n${job.description || ""}`,
    )
    .join("\n");
  return [...bySource.entries()].map(([sourceId, sourceCitations]) => {
    const sourcePage = phase2Evidence.knowledgePages.find(
      (page) => page.type === "source" && page.sourceIds.includes(sourceId),
    );
    const routedTopics = knowledgeRoutes
      .filter((page) => page.sourceIds.includes(sourceId))
      .map((page) => ({
        title: page.title,
        path: page.path,
        summary: page.summary,
        claimIds: page.claimIds,
        excerpt: page.content,
      }));
    const knowledgeContext = [
      ...routedTopics,
      ...(sourcePage
        ? [{
            title: sourcePage.title,
            path: sourcePage.path,
            summary: sourcePage.summary,
            claimIds: sourcePage.claimIds,
            excerpt: selectKnowledgeExcerpt(
              sourcePage.content,
              unresolvedText,
              12_000,
            ),
          }]
        : []),
    ];
    const canonicalCitations = uniqueCanonicalCitations(sourceCitations);
    return {
      sourceId,
      sourceName: phase2Evidence.sourceNames[sourceId] || sourceId,
      detailRef: `knowledge:${phase2Evidence.evidenceRunId}:${sourceId}`,
      content: JSON.stringify(
        {
          knowledgeContext,
          canonicalCitations,
        },
        null,
        2,
      ),
      citations: canonicalCitations,
    };
  });
}

export function uniqueCanonicalCitations(values: CanonicalClaimCitation[]) {
  return [
    ...new Map(
      values.map((value) => [
        `${value.claimId}:${value.sourceVersionId}:${value.locator}:${value.excerpt}`,
        value,
      ]),
    ).values(),
  ];
}

export function mergeTier2Assessments(
  tier1: AgentRequirementAssessment[],
  tier2: AgentRequirementAssessment[],
) {
  const tier2ByJob = new Map(tier2.map((assessment) => [assessment.jobId, assessment]));
  return tier1.map((assessment) => {
    const detailed = tier2ByJob.get(assessment.jobId);
    if (!detailed) return assessment;
    const byRequirement = new Map(
      detailed.requirements.map((requirement) => [
        requirementMergeKey(requirement),
        requirement,
      ]),
    );
    return {
      ...assessment,
      requirements: assessment.requirements.map((requirement) => {
        if (requirement.status === "matched") return requirement;
        const candidate = byRequirement.get(requirementMergeKey(requirement));
        return candidate &&
          requirementStatusRank(candidate.status) >
            requirementStatusRank(requirement.status)
          ? candidate
          : requirement;
      }),
    };
  });
}

export function enforceTier2ScaleGrounding(
  requirement: AgentRequirementAssessment["requirements"][number],
  documents: Tier2MatchingDocument[],
) {
  if (
    requirement.status !== "matched" ||
    !/\b(?:scalab(?:le|ility)|at scale|high[- ]volume|large[- ]scale)\b/i.test(
      requirement.requirement,
    )
  )
    return;
  const citedIds = new Set(
    requirement.evidence.map((evidence) => evidence.sourceId),
  );
  const support = documents
    .filter((document) => citedIds.has(document.sourceId))
    .map((document) => document.content)
    .join("\n");
  const affirmativeSupport = support.replace(
    /\b(?:no|not|without)\b[^.\n]{0,100}\b(?:load|scale|throughput|concurren\w*|requests?|users?|orders?|transactions?|measurements?)\b[^.\n]*/gi,
    "",
  );
  const observedScale =
    /\b\d[\d,.]*\s*(?:k|m|million|billion)?\s*(?:concurrent\s+)?(?:users?|requests?|orders?|events?|jobs?|messages?|transactions?|queries?)\s*(?:\/|per\s+)(?:second|minute|hour|day)\b/i.test(
      affirmativeSupport,
    ) ||
    /\b(?:load[- ]tested?|benchmark(?:ed|ing)?|operated|handled|served|sustained|production)\b[^.\n]{0,100}\b(?:load|scale|throughput|concurren|requests?|users?|orders?|transactions?)\b/i.test(
      affirmativeSupport,
    );
  if (observedScale) return;
  requirement.status = "partial";
  requirement.explanation = `${requirement.explanation.trim()} The detailed evidence shows scale-oriented architecture but does not establish that the system operated at meaningful scale.`;
}

export function requirementStatusRank(status: RequirementMatch["status"]) {
  return status === "matched" ? 2 : status === "partial" ? 1 : 0;
}

export function requirementMergeKey(
  requirement: AgentRequirementAssessment["requirements"][number],
) {
  return `${requirement.kind}:${requirement.requirement
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()}`;
}

export function calculateRequirementFit(
  requirements: RequirementMatch[],
): number {
  if (requirements.every((requirement) => !requirement.matchClass)) {
    let earned = 0;
    let possible = 0;
    for (const requirement of requirements) {
      const weight = requirement.kind === "required" ? 2 : 1;
      possible += weight;
      if (requirement.status === "matched") earned += weight;
      else if (requirement.status === "partial") earned += weight * 0.5;
    }
    return possible === 0 ? 0 : Math.round((earned / possible) * 100);
  }
  return calculateRequirementScore(requirements, []).final;
}

export function calculateRequirementScore(
  requirements: RequirementMatch[],
  canonicalLedger: CanonicalClaimCitation[],
) {
  let earned = 0;
  let possible = 0;
  let scopeEarned = 0;
  let domainEarned = 0;
  for (const requirement of requirements.filter(
    (item) => item.category !== "constraint",
  )) {
    const category = requirement.category ||
      (requirement.kind === "preferred" ? "preferred" : "mandatory");
    const weight = requirement.importanceWeight ?? requirementWeight(category);
    const matchClass = requirement.matchClass || normalizedMatchClass(requirement);
    const credit = requirement.credit ?? matchCredit(matchClass);
    const confidence = clamp01(requirement.confidence ?? 1);
    const claimConfidence = Math.max(
      0,
      ...requirement.evidence.map((entry) => {
        if (typeof entry.claimConfidence === "number") return entry.claimConfidence;
        return canonicalLedger.find(
          (claim) =>
            claim.claimId === entry.claimId && claim.sourceId === entry.sourceId,
        )?.confidence ?? 1;
      }),
    );
    possible += weight;
    earned += weight * credit * confidence * claimConfidence;
    scopeEarned += weight * (matchClass === "explicit" ? 1 : credit);
    domainEarned += weight * credit;
  }
  const coverage = possible === 0 ? 0 : clamp01(earned / possible);
  const scopeOwnershipAlignment = possible === 0 ? 0 : clamp01(scopeEarned / possible);
  const domainContextAlignment = possible === 0 ? 0 : clamp01(domainEarned / possible);
  const softPreferenceFit = 0;
  const final = Math.round(
    65 * coverage +
      15 * scopeOwnershipAlignment +
      10 * domainContextAlignment +
      10 * softPreferenceFit,
  );
  return {
    requirementCoverage: roundScore(coverage),
    scopeOwnershipAlignment: roundScore(scopeOwnershipAlignment),
    domainContextAlignment: roundScore(domainContextAlignment),
    softPreferenceFit,
    final,
  };
}

export function normalizedMatchClass(
  requirement:
    | AgentRequirementAssessment["requirements"][number]
    | RequirementMatch,
): NonNullable<RequirementMatch["matchClass"]> {
  if (requirement.matchClass) return requirement.matchClass;
  if (requirement.status === "matched") return "explicit";
  if (requirement.status === "partial") return "strong_adjacent";
  return "unsupported";
}

export function statusForMatchClass(
  matchClass: NonNullable<RequirementMatch["matchClass"]>,
): RequirementMatch["status"] {
  if (matchClass === "explicit") return "matched";
  if (matchClass === "strong_adjacent" || matchClass === "weak_adjacent")
    return "partial";
  return "missing";
}

export function matchCredit(matchClass: NonNullable<RequirementMatch["matchClass"]>) {
  if (matchClass === "explicit") return 1;
  if (matchClass === "strong_adjacent") return 0.65;
  if (matchClass === "weak_adjacent") return 0.3;
  if (matchClass === "contradicted") return -1;
  return 0;
}

export function requirementWeight(
  category: NonNullable<RequirementMatch["category"]>,
) {
  if (category === "mandatory") return 3;
  if (category === "responsibility") return 2;
  if (category === "preferred") return 1;
  return 0;
}

export function roundScore(value: number) {
  return Math.round(clamp01(value) * 1000) / 1000;
}

export function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function evaluateFeasibilityGate(
  _workspace: JobSearchWorkspace,
  _opportunity: JobOpportunity,
  _requirements: RequirementMatch[],
) {
  return { status: "passed" as const, reasons: [] };
}

export function phase2PortfolioCategory(
  fit: number,
  _requirements: RequirementMatch[],
  _feasibility: "passed" | "unknown" | "blocked",
  _opportunityConfidence: number,
): NonNullable<JobOpportunity["portfolioCategory"]> {
  if (fit >= 75) return "apply_now";
  if (fit >= 55) return "credible_adjacent";
  if (fit >= 35) return "stretch";
  return "watchlist";
}

export interface AssessmentVerification {
  jobId: string;
  verdict: "pass" | "needs_repair";
  findings: Array<{
    code: string;
    requirement: string;
    message: string;
  }>;
  repairInstructions: string[];
  inflationFlags?: string[];
  feasibilityFlags?: string[];
  statusConfidence?: number;
  decision?: "accepted" | "revised" | "rejected";
  rationale?: string;
}

export async function verifyAndRepairAssessments(
  codex: CodexExecClient,
  cwd: string,
  model: string | undefined,
  sourceLedger: unknown,
  opportunities: JobOpportunity[],
  assessments: AgentRequirementAssessment[],
) {
  const first = await verifyAssessments(
    codex,
    cwd,
    model,
    sourceLedger,
    opportunities,
    assessments,
  );
  const failed = first.filter((item) => item.verdict === "needs_repair");
  if (failed.length === 0)
    return {
      assessments,
      rejected: [] as AssessmentVerification[],
      reviews: first,
    };

  const failedIds = new Set(failed.map((item) => item.jobId));
  const repairModel = model ?? productionModel(MATCH_REPAIR_COMMAND);
  const thread = await codex.startThread({
    cwd,
    callId: "match.repair",
    role: MATCH_REPAIR_COMMAND.role,
    sandbox: "read-only",
    model: repairModel,
    approvalPolicy: MATCH_REPAIR_COMMAND.approvalPolicy,
    developerInstructions: MATCH_REPAIR_ROLE_PROMPT,
  });
  const repairTurn = {
    threadId: thread.id,
    cwd,
    sandbox: MATCH_REPAIR_COMMAND.sandbox,
    outputSchema: matchRepairSchema,
    model: repairModel,
    effort: MATCH_REPAIR_COMMAND.effort,
    timeoutMs: MATCH_REPAIR_COMMAND.timeoutMs,
  } as const;
  let result;
  try {
    result = await codex.runTurn({
      ...repairTurn,
      prompt: buildMatchRepairInput({
        sourceLedger,
        opportunities,
        assessments,
        failures: failed,
      }),
    });
  } catch (error) {
    if (!isRetryableMatchRepairDefect(error)) throw error;
    result = await codex.runTurn({
      ...repairTurn,
      prompt: buildMatchRepairRecoveryInput(error.report.defects),
    });
  }
  const repairedAssessment = JSON.parse(
    result.finalText,
  ) as RequirementAssessmentOutput;
  if (failedIds.size !== 1)
    throw new Error(
      `Match repair is one-job-per-call; received ${failedIds.size} job ids`,
    );
  assertAssessmentJobId(
    repairedAssessment,
    [...failedIds][0],
    "match.repair",
  );
  const repaired = [repairedAssessment];
  const repairedById = new Map(repaired.map((item) => [item.jobId, item]));
  const merged = assessments.map((item) => repairedById.get(item.jobId) || item);
  const finalVerification = await verifyAssessments(
    codex,
    cwd,
    model,
    sourceLedger,
    opportunities.filter((job) => failedIds.has(job.id)),
    merged.filter((item) => failedIds.has(item.jobId)),
  );
  const rejected = finalVerification.filter(
    (item) => item.verdict === "needs_repair",
  );
  const mergedById = new Map(merged.map((item) => [item.jobId, item]));
  const unrecoverable = rejected.filter(
    (item) => !mergedById.get(item.jobId)?.requirements.length,
  );
  const unrecoverableIds = new Set(
    unrecoverable.map((item) => item.jobId),
  );
  return {
    // A verifier finding is a reason to keep the skeptical review and lower
    // unsupported rows, not to discard an otherwise complete live vacancy.
    // The deterministic conversion below already turns invalid or uncited
    // evidence into missing requirements before scoring.
    assessments: merged.filter((item) => !unrecoverableIds.has(item.jobId)),
    rejected: unrecoverable,
    reviews: [
      ...first.filter((item) => !failedIds.has(item.jobId)),
      ...finalVerification,
    ],
  };
}

const RETRYABLE_MATCH_REPAIR_DEFECTS = new Set([
  "DUPLICATE_REQUIREMENT",
  "INCONSISTENT_MATCH_STATE",
]);

function isRetryableMatchRepairDefect(
  error: unknown,
): error is ResultGatewayError {
  return (
    error instanceof ResultGatewayError &&
    error.report.callId === "match.repair" &&
    error.report.defects.length > 0 &&
    error.report.defects.every((defect) =>
      RETRYABLE_MATCH_REPAIR_DEFECTS.has(defect.code),
    )
  );
}

export async function verifyAssessments(
  codex: CodexExecClient,
  cwd: string,
  model: string | undefined,
  sourceLedger: unknown,
  opportunities: JobOpportunity[],
  assessments: AgentRequirementAssessment[],
): Promise<AssessmentVerification[]> {
  const deterministicFindings = deterministicAssessmentFindings(
    sourceLedger,
    opportunities,
    assessments,
  );
  if (opportunities.length !== 1 || assessments.length !== 1)
    throw new Error(
      `Match verification is one-job-per-call; received ${opportunities.length} jobs and ${assessments.length} assessments`,
    );
  const verification = await runMatchVerificationCall({
    codex,
    cwd,
    model,
    sourceLedger,
    opportunities,
    assessments,
    deterministicFindings,
  });
  if (verification.jobId !== opportunities[0].id)
    throw new Error(
      `match.verification returned jobId ${verification.jobId}; expected ${opportunities[0].id}`,
    );
  const verifications = [verification];
  const byId = new Map(verifications.map((item) => [item.jobId, item]));
  return opportunities.map((job) => {
    const modelResult = byId.get(job.id);
    const codeFindings = deterministicFindings.filter(
      (item) => item.jobId === job.id,
    );
    if (!modelResult)
      return {
        jobId: job.id,
        verdict: "needs_repair" as const,
        findings: [
          {
            code: "verifier_omission",
            requirement: "",
            message: "Verifier omitted this vacancy",
          },
        ],
        repairInstructions: ["Return a complete assessment for this jobId"],
      };
    if (codeFindings.length === 0) return modelResult;
    return {
      ...modelResult,
      verdict: "needs_repair" as const,
      findings: [
        ...modelResult.findings,
        ...codeFindings.map((item) => ({
          code: item.code,
          requirement: item.requirement,
          message: item.message,
        })),
      ],
      repairInstructions: [
        ...modelResult.repairInstructions,
        ...codeFindings.map((item) => item.message),
      ],
    };
  });
}

function assertAssessmentJobId(
  assessment: AgentRequirementAssessment,
  expectedJobId: string,
  callId: string,
) {
  if (assessment.jobId !== expectedJobId)
    throw new Error(
      `${callId} returned jobId ${assessment.jobId}; expected ${expectedJobId}`,
    );
}

export function deterministicAssessmentFindings(
  sourceLedger: unknown,
  opportunities: JobOpportunity[],
  assessments: AgentRequirementAssessment[],
) {
  const sources = Array.isArray(sourceLedger) ? sourceLedger : [];
  const sourceIds = new Set(
    sources
      .map((item) =>
        typeof item === "object" && item && "sourceId" in item
          ? String(item.sourceId)
          : "",
      )
      .filter(Boolean),
  );
  const canonicalLedger = sources.filter(
    (item): item is CanonicalClaimCitation =>
      typeof item === "object" &&
      item !== null &&
      "claimId" in item &&
      "supportStatus" in item &&
      "excerpt" in item,
  );
  const byId = new Map(assessments.map((item) => [item.jobId, item]));
  const findings: Array<{
    jobId: string;
    code: string;
    requirement: string;
    message: string;
  }> = [];
  for (const job of opportunities) {
    const assessment = byId.get(job.id);
    const responsibilitiesText = extractResponsibilitiesSection(
      job.description || job.summary,
    );
    const qualificationText = extractQualificationSection(
      job.description || job.summary,
    );
    if (!assessment?.requirements.length) {
      findings.push({
        jobId: job.id,
        code: "missing_assessment",
        requirement: "",
        message: "The vacancy has no requirement assessment",
      });
      continue;
    }
    for (const row of assessment.requirements) {
      const category = normalizedRequirementCategory(row);
      const groundingText =
        category === "responsibility" ? responsibilitiesText : qualificationText;
      if (
        groundingText &&
        !requirementIsExplicitQualification(row.requirement, groundingText)
      )
        findings.push({
          jobId: job.id,
          code: "requirement_outside_declared_section",
          requirement: row.requirement,
          message:
            `This ${category} row is not grounded in the vacancy's corresponding source section and must be removed or recategorized`,
        });
      if (!row.requirement.trim())
        findings.push({
          jobId: job.id,
          code: "empty_requirement",
          requirement: "",
          message: "A requirement row has no employer requirement text",
        });
      if (
        row.status === "missing" &&
        row.matchClass !== "contradicted" &&
        row.evidence.length
      )
        findings.push({
          jobId: job.id,
          code: "missing_with_evidence",
          requirement: row.requirement,
          message: "A missing requirement must not contain evidence",
        });
      if (
        row.status !== "missing" &&
        (!row.evidence.length ||
          row.evidence.some(
            (entry) =>
              !sourceIds.has(entry.sourceId) ||
              !entry.excerpt.trim() ||
              (canonicalLedger.length > 0 &&
                !canonicalCitationIsValid(canonicalLedger, entry)),
          ))
      )
        findings.push({
          jobId: job.id,
          code: "invalid_evidence",
          requirement: row.requirement,
          message: "A matched or partial requirement has missing or invalid evidence",
        });
      if (
        row.status === "matched" &&
        row.evidence.some((entry) =>
          canonicalLedger.some(
            (citation) =>
              citation.claimId === entry.claimId &&
              citation.sourceId === entry.sourceId &&
              citation.supportStatus !== "supported",
          ),
        )
      )
        findings.push({
          jobId: job.id,
          code: "weak_claim_promoted",
          requirement: row.requirement,
          message: "A weakly supported claim may justify partial, not matched",
        });
    }
  }
  return findings;
}

export function normalizedRequirementCategory(
  requirement: AgentRequirementAssessment["requirements"][number],
): NonNullable<RequirementMatch["category"]> {
  if (requirement.category) return requirement.category;
  if (requirement.kind === "preferred") return "preferred";
  if (
    /\b(?:authorization|authorisation|visa|sponsor|clearance|license|licence|location|timezone|time zone|travel|shift)\b/i.test(
      requirement.requirement,
    )
  )
    return "constraint";
  return "mandatory";
}

export const qualificationStopWords = new Set([
  "ability",
  "and",
  "candidate",
  "candidates",
  "demonstrated",
  "experience",
  "have",
  "knowledge",
  "must",
  "proficiency",
  "required",
  "role",
  "skills",
  "strong",
  "the",
  "this",
  "with",
  "years",
  "you",
  "your",
]);

export function qualificationTokens(text: string) {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9+#]+/)
        .filter(
          (token) =>
            token.length >= 3 && !qualificationStopWords.has(token),
        ),
    ),
  );
}

export function requirementIsExplicitQualification(
  requirement: string,
  qualificationText: string,
) {
  if (!qualificationText.trim()) return true;
  const tokens = qualificationTokens(requirement);
  if (tokens.length === 0) return false;
  const qualificationTokensSet = new Set(qualificationTokens(qualificationText));
  const overlap = tokens.filter((token) => qualificationTokensSet.has(token)).length;
  return overlap / tokens.length >= 0.45;
}
