import type { JobOpportunity, JobSearchWorkspace } from "../contracts/job-search.js";
import { readEvidenceModel } from "../01-evidence-ingestion/04-verification/evidence-model.js";
import { applyEvidenceReviews } from "./evidence-review.js";
import {
  knowledgeOverlap as overlap,
  knowledgeTokens as tokens,
  loadEvidenceKnowledgePages,
  normalizeKnowledgeText as normalize,
  retrieveKnowledgeRoutes,
  type Phase2KnowledgePage,
} from "./knowledge-context.js";
export {
  retrieveKnowledgeRoutes,
  selectKnowledgeExcerpt,
} from "./knowledge-context.js";
export type {
  Phase2KnowledgePage,
  Phase2KnowledgeRoute,
} from "./knowledge-context.js";
import type {
  CandidateConstraints,
  CandidateContradiction,
  CandidateUnknown,
  Capability,
  EvidenceClaim,
  EvidenceReadiness,
  EvidenceRunManifest,
  ProhibitedInference,
  RoleFamily,
  SearchVocabularyDraft,
} from "../contracts/evidence.js";

export interface Phase2SearchLane {
  roleFamilyId: string;
  roleClass: RoleFamily["roleClass"];
  canonicalTitle: string;
  titleAliases: string[];
  leadingCapabilities: string[];
  problemPhrases: string[];
  evidenceIntersections: string[];
  toolsMethods: string[];
  queryVariants: string[];
  queries: Array<{
    family:
      | "title_baseline"
      | "evidence_intersection"
      | "problem_language"
      | "official_ats"
      | "company_first"
      | "specialist_local"
      | "requirement_inversion";
    query: string;
  }>;
  confidence: number;
}

export interface Phase2EvidenceContext {
  evidenceRunId: string;
  manifest: EvidenceRunManifest;
  readiness: EvidenceReadiness;
  claims: EvidenceClaim[];
  capabilities: Capability[];
  roleFamilies: RoleFamily[];
  searchVocabulary: SearchVocabularyDraft;
  constraints: CandidateConstraints;
  unknowns: CandidateUnknown[];
  contradictions: CandidateContradiction[];
  prohibitedInferences: ProhibitedInference[];
  searchLanes: Phase2SearchLane[];
  sourceNames: Record<string, string>;
  knowledgePages: Phase2KnowledgePage[];
}

export interface CanonicalClaimCitation {
  claimId: string;
  sourceId: string;
  sourceName: string;
  sourceVersionId: string;
  locator: string;
  excerpt: string;
  supportStatus: EvidenceClaim["supportStatus"];
  confidence: number;
  action: string;
  capability: string;
  workContexts: string[];
  toolsMethods: string[];
  ownership: EvidenceClaim["ownership"];
  maturity: EvidenceClaim["maturity"];
  scope: EvidenceClaim["scope"];
  outcomes: EvidenceClaim["outcomes"];
  limitations: string[];
}

interface StoredEvidenceModel {
  manifest: EvidenceRunManifest;
  claims: EvidenceClaim[];
  capabilities: Capability[];
  constraints: CandidateConstraints;
  unknowns: CandidateUnknown[];
  contradictions: CandidateContradiction[];
  prohibitedInferences: ProhibitedInference[];
  roleFamilies: RoleFamily[];
  searchVocabulary: SearchVocabularyDraft;
  readiness: EvidenceReadiness;
}

export async function loadPhase2EvidenceContext(
  dataRoot: string,
  workspace: JobSearchWorkspace,
): Promise<Phase2EvidenceContext | undefined> {
  const expected = workspace.intelligence?.evidenceRun;
  if (!expected) return undefined;
  if (!expected.readyForSearch)
    throw new Error(
      `Canonical evidence is not ready for search: ${expected.blockers.join("; ") || "readiness gate failed"}`,
    );
  const model = (await readEvidenceModel(
    dataRoot,
    workspace.candidateId,
    expected.id,
  )) as StoredEvidenceModel;
  if (!model.readiness.readyForSearch)
    throw new Error(
      `Canonical evidence is not ready for search: ${model.readiness.blockers.join("; ") || "readiness gate failed"}`,
    );
  const sourceNames = Object.fromEntries(
    workspace.sources.map((source) => [source.id, source.name]),
  );
  const knowledgePages = await loadEvidenceKnowledgePages(
    dataRoot,
    workspace.candidateId,
    model.manifest.evidenceRunId,
  );
  const reviewedEvidence = applyEvidenceReviews(
    model.claims,
    model.contradictions,
    workspace.profile,
    workspace.intelligence.evidenceReview,
  );
  return {
    evidenceRunId: model.manifest.evidenceRunId,
    manifest: model.manifest,
    readiness: model.readiness,
    claims: reviewedEvidence.claims,
    capabilities: model.capabilities,
    roleFamilies: model.roleFamilies,
    searchVocabulary: model.searchVocabulary,
    constraints: model.constraints,
    unknowns: model.unknowns,
    contradictions: reviewedEvidence.contradictions,
    prohibitedInferences: model.prohibitedInferences,
    searchLanes: buildPhase2SearchLanes(
      model.roleFamilies,
      model.capabilities,
      model.searchVocabulary,
    ),
    sourceNames,
    knowledgePages,
  };
}

export function buildPhase2SearchLanes(
  roles: RoleFamily[],
  capabilities: Capability[],
  vocabulary: SearchVocabularyDraft,
): Phase2SearchLane[] {
  const capabilityById = new Map(
    capabilities.map((capability) => [capability.capabilityId, capability]),
  );
  return [...roles]
    .sort(
      (left, right) =>
        roleClassRank(left.roleClass) - roleClassRank(right.roleClass) ||
        right.confidence - left.confidence,
    )
    .map((role) => {
      const leading = role.leadingCapabilityIds
        .map((id) => capabilityById.get(id))
        .filter((item): item is Capability => Boolean(item));
      const roleText = [
        role.canonicalTitle,
        ...role.titleAliases,
        ...role.problemPhrases,
        ...leading.flatMap((capability) => [
          capability.name,
          ...capability.directAliases,
          ...capability.adjacentAliases,
        ]),
      ].join(" ");
      const evidenceIntersections = rankTerms(
        vocabulary.evidenceIntersections,
        roleText,
        5,
      );
      const toolsMethods = rankCapabilityTools(leading, roleText, 8);
      const titleAliases = unique([
        role.canonicalTitle,
        ...role.titleAliases,
      ]).slice(0, 6);
      const leadingCapabilities = leading.map((item) => item.name).slice(0, 8);
      const queryVariants = unique([
        [titleAliases[0], ...leadingCapabilities.slice(0, 3)]
          .filter(Boolean)
          .join(" "),
        [
          titleAliases[1] || titleAliases[0],
          role.problemPhrases[0],
          evidenceIntersections[0],
        ]
          .filter(Boolean)
          .join(" "),
        [titleAliases[0], ...toolsMethods.slice(0, 4)]
          .filter(Boolean)
          .join(" "),
      ]).filter(Boolean);
      const negative = vocabulary.negativeTerms
        .slice(0, 2)
        .map((term) => `-${term.replace(/\s+/g, "-")}`)
        .join(" ");
      const queries: Phase2SearchLane["queries"] = [
        {
          family: "title_baseline",
          query: titleAliases[0],
        },
        {
          family: "evidence_intersection",
          query: [titleAliases[0], ...evidenceIntersections.slice(0, 2)]
            .filter(Boolean)
            .join(" "),
        },
        {
          family: "problem_language",
          query: [role.problemPhrases[0], ...leadingCapabilities.slice(0, 2)]
            .filter(Boolean)
            .join(" "),
        },
        {
          family: "official_ats",
          query: [titleAliases[0], "careers jobs apply"]
            .filter(Boolean)
            .join(" "),
        },
        {
          family: "company_first",
          query: [
            "companies hiring",
            evidenceIntersections[0] || leadingCapabilities[0],
            role.problemPhrases[0],
          ]
            .filter(Boolean)
            .join(" "),
        },
        {
          family: "specialist_local",
          query: [titleAliases[1] || titleAliases[0], toolsMethods[0], "jobs"]
            .filter(Boolean)
            .join(" "),
        },
        {
          family: "requirement_inversion",
          query: [
            titleAliases[0],
            evidenceIntersections[0] || leadingCapabilities[0],
            negative,
          ]
            .filter(Boolean)
            .join(" "),
        },
      ];
      return {
        roleFamilyId: role.roleFamilyId,
        roleClass: role.roleClass,
        canonicalTitle: role.canonicalTitle,
        titleAliases,
        leadingCapabilities,
        problemPhrases: role.problemPhrases.slice(0, 6),
        evidenceIntersections,
        toolsMethods,
        queryVariants,
        queries,
        confidence: role.confidence,
      };
    });
}

export function phase2DiscoveryPacket(context: Phase2EvidenceContext) {
  return {
    evidenceRunId: context.evidenceRunId,
    searchLanes: context.searchLanes,
    sharedVocabulary: {
      evidenceIntersections:
        context.searchVocabulary.evidenceIntersections.slice(0, 20),
      problemPhrases: context.searchVocabulary.problemPhrases.slice(0, 30),
      toolsMethodsStandards:
        context.searchVocabulary.toolsMethodsStandards.slice(0, 40),
      adjacentDialects: context.searchVocabulary.adjacentDialects.slice(0, 20),
      seniorityOwnershipModifiers:
        context.searchVocabulary.seniorityOwnershipModifiers.slice(0, 12),
      negativeTerms: context.searchVocabulary.negativeTerms.slice(0, 20),
    },
    constraints: context.constraints,
    materialUnknowns: context.unknowns.filter(
      (unknown) => unknown.materiality !== "low",
    ),
    prohibitedInferences: context.prohibitedInferences,
  };
}

export function phase2ActiveSearchLanes(
  context: Phase2EvidenceContext,
  wave = 0,
) {
  const direct = context.searchLanes.filter((lane) => lane.roleClass === "direct");
  const adjacent = context.searchLanes.filter(
    (lane) => lane.roleClass === "adjacent",
  );
  const stretch = context.searchLanes.filter(
    (lane) => lane.roleClass === "stretch",
  );
  const primary = direct.length > 0 ? direct : adjacent;
  if (wave < 2) return primary.length > 0 ? primary : stretch;
  if (wave < 4) {
    const credible = [...direct, ...adjacent];
    return credible.length > 0 ? credible : stretch;
  }
  return context.searchLanes;
}

export function phase2QueryPortfolio(
  context: Phase2EvidenceContext,
  wave = 0,
  limit = 4,
) {
  const activeLanes = phase2ActiveSearchLanes(context, wave);
  if (activeLanes.length === 0) return [];
  const variants = activeLanes.flatMap((lane) =>
    lane.queries.map((item, variantIndex) => ({
      roleFamilyId: lane.roleFamilyId,
      roleClass: lane.roleClass,
      canonicalTitle: lane.canonicalTitle,
      query: item.query,
      queryFamily: item.family,
      variantIndex,
    })),
  );
  const laneCount = activeLanes.length;
  const startLane = (Math.max(0, wave) * limit) % laneCount;
  const selected: typeof variants = [];
  for (let offset = 0; offset < laneCount && selected.length < limit; offset += 1) {
    const lane = activeLanes[(startLane + offset) % laneCount];
    const variantIndex = Math.max(0, wave) % Math.max(1, lane.queries.length);
    const selectedQuery = lane.queries[variantIndex] || lane.queries[0];
    const query = selectedQuery?.query || lane.queryVariants[0];
    if (!query) continue;
    selected.push({
      roleFamilyId: lane.roleFamilyId,
      roleClass: lane.roleClass,
      canonicalTitle: lane.canonicalTitle,
      query,
      queryFamily: selectedQuery?.family || "title_baseline",
      variantIndex,
    });
  }
  return selected;
}

export function retrieveCanonicalClaimLedger(
  context: Phase2EvidenceContext,
  opportunities: Array<Pick<JobOpportunity, "id" | "title" | "summary" | "description">>,
  maximumClaimsPerJob = 40,
) {
  const capabilityByClaim = new Map<string, Capability[]>();
  for (const capability of context.capabilities)
    for (const claimId of capability.claimIds)
      capabilityByClaim.set(claimId, [
        ...(capabilityByClaim.get(claimId) || []),
        capability,
      ]);
  return opportunities.map((opportunity) => {
    const knowledgeRoutes = retrieveKnowledgeRoutes(context, [opportunity])[0]
      ?.pages || [];
    const knowledgeScoreByClaim = new Map<string, number>();
    for (const route of knowledgeRoutes)
      for (const claimId of route.claimIds)
        knowledgeScoreByClaim.set(
          claimId,
          Math.max(knowledgeScoreByClaim.get(claimId) || 0, route.score),
        );
    const alignment = canonicalOpportunityAlignment(context, {
      title: opportunity.title,
      description: `${opportunity.summary} ${opportunity.description || ""}`,
    });
    if (alignment < 20 && knowledgeRoutes.length === 0)
      return { jobId: opportunity.id, evidence: [] };
    const jobText = `${opportunity.title} ${opportunity.summary} ${opportunity.description || ""}`;
    const jobTokens = tokens(jobText);
    const ranked = context.claims
      .filter(
        (claim) =>
          claim.status === "active" &&
          (claim.supportStatus === "supported" ||
            claim.supportStatus === "weakly_supported") &&
          claim.sourceRefs.length > 0,
      )
      .map((claim) => {
        const capabilities = capabilityByClaim.get(claim.claimId) || [];
        const capabilityText = capabilities
          .flatMap((capability) => [
            capability.name,
            ...capability.directAliases,
            ...capability.adjacentAliases,
          ])
          .join(" ");
        const capabilityOverlap = overlap(jobTokens, tokens(capabilityText));
        const claimOverlap = overlap(
          jobTokens,
          tokens(
            `${claim.capability} ${claim.action} ${claim.workContexts.join(" ")} ${claim.toolsMethods.join(" ")} ${claim.outcomes.map((item) => item.description).join(" ")}`,
          ),
        );
        const roleBonus = context.searchLanes.some(
          (lane) =>
            overlap(jobTokens, tokens(`${lane.canonicalTitle} ${lane.titleAliases.join(" ")}`)) >
              0 &&
            lane.leadingCapabilities.some((name) =>
              capabilities.some(
                (capability) => normalize(capability.name) === normalize(name),
              ),
            ),
        )
          ? 4
          : 0;
        const knowledgeScore = knowledgeScoreByClaim.get(claim.claimId) || 0;
        return {
          claim,
          hasSubstantiveOverlap:
            capabilityOverlap > 0 ||
            claimOverlap >= 2 ||
            roleBonus > 0 ||
            knowledgeScore > 0,
          score:
            capabilityOverlap * 7 +
            claimOverlap * 3 +
            roleBonus +
            Math.min(20, knowledgeScore) +
            claim.confidence +
            (claim.supportStatus === "supported" ? 2 : 0),
        };
      })
      .filter((item) => item.hasSubstantiveOverlap && item.score > 2)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.claim.confidence - left.claim.confidence ||
          left.claim.claimId.localeCompare(right.claim.claimId),
      )
      .slice(0, maximumClaimsPerJob);
    const evidence = ranked.flatMap(({ claim }) =>
      claim.sourceRefs.slice(0, 1).map(
        (ref): CanonicalClaimCitation => ({
          claimId: claim.claimId,
          sourceId: ref.sourceId,
          sourceName: context.sourceNames[ref.sourceId] || ref.sourceId,
          sourceVersionId: ref.sourceVersionId,
          locator: ref.locator,
          excerpt: ref.quote,
          supportStatus: claim.supportStatus,
          confidence: claim.confidence,
          action: claim.action,
          capability: claim.capability,
          workContexts: claim.workContexts,
          toolsMethods: claim.toolsMethods,
          ownership: claim.ownership,
          maturity: claim.maturity,
          scope: claim.scope,
          outcomes: claim.outcomes,
          limitations: claim.limitations,
        }),
      ),
    );
    return { jobId: opportunity.id, evidence };
  });
}

export function canonicalCitationIsValid(
  ledger: CanonicalClaimCitation[],
  citation: { claimId?: string; sourceId: string; excerpt: string },
) {
  if (!citation.claimId) return false;
  const excerpt = normalize(citation.excerpt);
  return ledger.some(
    (entry) =>
      entry.claimId === citation.claimId &&
      entry.sourceId === citation.sourceId &&
      excerpt.length > 0 &&
      (normalize(entry.excerpt).includes(excerpt) ||
        excerpt.includes(normalize(entry.excerpt))),
  );
}

export function canonicalStrengthsForTitle(
  context: Phase2EvidenceContext,
  title: string,
) {
  const titleTokens = tokens(title);
  return context.capabilities
    .map((capability) => ({
      capability,
      score: overlap(
        titleTokens,
        tokens(
          `${capability.name} ${capability.directAliases.join(" ")} ${capability.adjacentAliases.join(" ")}`,
        ),
      ),
    }))
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.capability.evidenceStrength - left.capability.evidenceStrength,
    )
    .slice(0, 4)
    .map((item) => item.capability.name);
}

export function canonicalOpportunityAlignment(
  context: Phase2EvidenceContext,
  opportunity: { title: string; description?: string },
) {
  const titleTokens = tokens(opportunity.title);
  const descriptionTokens = tokens(opportunity.description || "");
  const scores = context.searchLanes.map((lane) => {
    const aliasTokens = tokens(
      `${lane.canonicalTitle} ${lane.titleAliases.join(" ")}`,
    );
    const evidenceTokens = tokens(
      `${lane.leadingCapabilities.join(" ")} ${lane.problemPhrases.join(" ")} ${lane.evidenceIntersections.join(" ")} ${lane.toolsMethods.join(" ")}`,
    );
    const titleCoverage = aliasTokens.size
      ? overlap(titleTokens, aliasTokens) / Math.min(titleTokens.size || 1, aliasTokens.size)
      : 0;
    const evidenceCoverage = evidenceTokens.size
      ? overlap(descriptionTokens, evidenceTokens) /
        Math.min(Math.max(1, descriptionTokens.size), evidenceTokens.size)
      : 0;
    const roleClassWeight = lane.roleClass === "direct" ? 1 : lane.roleClass === "adjacent" ? 0.85 : 0.7;
    return (
      titleCoverage * 0.55 +
      Math.min(1, evidenceCoverage * 2) * 0.3 +
      lane.confidence * roleClassWeight * 0.15
    );
  });
  return Math.round(Math.max(0, Math.min(1, Math.max(0, ...scores))) * 100);
}

export function canonicalOpportunityIsExcluded(
  context: Phase2EvidenceContext,
  title: string,
) {
  const normalizedTitle = ` ${normalize(title)} `;
  return context.searchVocabulary.negativeTerms.some((term) => {
    const normalizedTerm = normalize(term);
    return normalizedTerm.length > 1 && normalizedTitle.includes(` ${normalizedTerm} `);
  });
}

function rankTerms(
  values: string[],
  target: string,
  limit: number,
  keepZero = false,
) {
  const targetTokens = tokens(target);
  return values
    .map((value, index) => ({
      value,
      index,
      score: overlap(targetTokens, tokens(value)),
    }))
    .filter((item) => keepZero || item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((item) => item.value);
}

function rankCapabilityTools(
  capabilities: Capability[],
  target: string,
  limit: number,
) {
  const targetTokens = tokens(target);
  const counts = new Map<string, { value: string; count: number; index: number }>();
  let index = 0;
  for (const tool of capabilities.flatMap((capability) => capability.toolsMethods)) {
    const key = normalize(tool);
    if (!key || tool.length > 64) continue;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { value: tool, count: 1, index: index++ });
  }
  return [...counts.values()]
    .map((item) => ({
      ...item,
      overlap: overlap(targetTokens, tokens(item.value)),
    }))
    .sort(
      (left, right) =>
        right.overlap - left.overlap ||
        right.count - left.count ||
        left.index - right.index,
    )
    .slice(0, limit)
    .map((item) => item.value);
}

function roleClassRank(value: RoleFamily["roleClass"]) {
  return value === "direct" ? 0 : value === "adjacent" ? 1 : 2;
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
