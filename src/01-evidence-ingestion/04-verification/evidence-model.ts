import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { CandidateAnalysisResult } from "../types.js";
import type {
  CandidateProfile,
  CandidateSource,
  JobSearchWorkspace,
} from "../../contracts/job-search.js";
import {
  EVIDENCE_PROMPT_VERSION,
  EVIDENCE_SCHEMA_VERSION,
  SOURCE_PARSER_VERSION,
  type CandidateConstraints,
  type CandidateContradiction,
  type CandidateUnknown,
  type Capability,
  type EvidenceClaim,
  type EvidenceClaimDraft,
  type EvidenceMaturity,
  type EvidenceOwnership,
  type EvidenceReadiness,
  type EvidenceRunManifest,
  type EvidenceScope,
  type ProfileFieldEvidence,
  type ProhibitedInference,
  type RoleFamily,
  type SearchVocabularyDraft,
  type SourceBlock,
  type SourceRef,
  type SourceSnapshot,
} from "../../contracts/evidence.js";
import {
  buildEvidenceKnowledgeBase,
  writeEvidenceKnowledgeBase,
} from "./knowledge-base/index.js";

const OWNERSHIP_RANK: EvidenceOwnership[] = [
  "unknown",
  "assisted",
  "contributor",
  "primary",
  "shared_owner",
  "lead",
  "manager",
  "end_to_end_owner",
  "organizational_owner",
];
const MATURITY_RANK: EvidenceMaturity[] = [
  "unknown",
  "concept",
  "designed",
  "piloted",
  "implemented",
  "operated",
  "measured",
];
const SCOPE_RANK: EvidenceScope[] = [
  "unknown",
  "task",
  "process",
  "component",
  "system",
  "service",
  "site",
  "team",
  "department",
  "product",
  "organization",
];

export interface PersistedEvidenceRun {
  manifest: EvidenceRunManifest;
  directory: string;
}

export async function persistCanonicalEvidenceRun(input: {
  dataRoot: string;
  workspace: JobSearchWorkspace;
  analysis: CandidateAnalysisResult;
  profileEvidence?: ProfileFieldEvidence[];
  profileEvidenceBlockers?: string[];
}): Promise<PersistedEvidenceRun> {
  const { dataRoot, workspace, analysis } = input;
  const profileEvidence = input.profileEvidence || [];
  const snapshots = workspace.sources.map((source) =>
    sourceSnapshot(workspace.candidateId, source),
  );
  await persistSourceSnapshots(
    dataRoot,
    workspace.sources.filter((source) => source.kind !== "cv"),
    snapshots.filter((snapshot) => snapshot.kind !== "cv"),
  );
  const blocks = workspace.sources.flatMap((source) =>
    sourceBlocks(source, snapshots.find((item) => item.sourceId === source.id)!),
  );
  const claims = auditClaims(workspace, analysis, snapshots);
  const capabilities = aggregateCapabilities(claims, analysis);
  const unknowns = canonicalUnknowns(analysis, workspace);
  const contradictions = canonicalContradictions(analysis);
  const prohibitedInferences = canonicalProhibitedInferences(
    analysis,
    workspace.sources,
  );
  const constraints = candidateConstraints(workspace.profile);
  const roleFamilies = canonicalRoleFamilies(analysis, capabilities, workspace.profile);
  const searchVocabulary = canonicalSearchVocabulary(analysis, capabilities, roleFamilies);
  const knowledge = buildEvidenceKnowledgeBase({
    workspace,
    analysis,
    snapshots,
    claims,
    capabilities,
    roleFamilies,
    unknowns,
    prohibitedInferences,
  });
  const readiness = evidenceReadiness({
    snapshots,
    blocks,
    claims,
    capabilities,
    roleFamilies,
    unknowns,
    contradictions,
    additionalBlockers: input.profileEvidenceBlockers || [],
  });
  const runFingerprint = stableHash(
    JSON.stringify({
      schema: EVIDENCE_SCHEMA_VERSION,
      prompt: EVIDENCE_PROMPT_VERSION,
      sources: snapshots.map((item) => item.sourceVersionId).sort(),
      claims,
      capabilities,
      constraints,
      unknowns,
      contradictions,
      prohibitedInferences,
      profileEvidence,
      roleFamilies,
      searchVocabulary,
      knowledge: knowledge.files,
      readiness,
    }),
  );
  const evidenceRunId = `evidence-${runFingerprint.slice(0, 20)}`;
  const candidateRunRoot = path.join(
    dataRoot,
    "job-search",
    "runs",
    workspace.candidateId,
    "evidence-runs",
  );
  const runDirectory = path.join(candidateRunRoot, evidenceRunId);
  const artifacts = [
    "sources.jsonl",
    "source-blocks.jsonl",
    "claims.jsonl",
    "capabilities.json",
    "timeline.json",
    "constraints.json",
    "unknowns.json",
    "contradictions.json",
    "prohibited-inferences.json",
    "profile-evidence.json",
    "role-families.json",
    "search-vocabulary.json",
    "readiness.json",
    ...knowledge.files.map((file) => path.posix.join("knowledge", file.path)),
    "manifest.json",
  ];
  const manifest: EvidenceRunManifest = {
    evidenceRunId,
    candidateId: workspace.candidateId,
    createdAt: new Date().toISOString(),
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    promptVersion: EVIDENCE_PROMPT_VERSION,
    sourceVersionIds: snapshots.map((item) => item.sourceVersionId),
    artifacts,
    readiness,
  };

  await mkdir(candidateRunRoot, { recursive: true });
  if (!(await exists(runDirectory))) {
    const temporary = `${runDirectory}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(temporary, { recursive: true });
    try {
      await Promise.all([
        writeJsonl(path.join(temporary, "sources.jsonl"), snapshots),
        writeJsonl(path.join(temporary, "source-blocks.jsonl"), blocks),
        writeJsonl(path.join(temporary, "claims.jsonl"), claims),
        writeJson(path.join(temporary, "capabilities.json"), capabilities),
        writeJson(path.join(temporary, "timeline.json"), claimTimeline(claims)),
        writeJson(path.join(temporary, "constraints.json"), constraints),
        writeJson(path.join(temporary, "unknowns.json"), unknowns),
        writeJson(path.join(temporary, "contradictions.json"), contradictions),
        writeJson(
          path.join(temporary, "prohibited-inferences.json"),
          prohibitedInferences,
        ),
        writeJson(
          path.join(temporary, "profile-evidence.json"),
          profileEvidence,
        ),
        writeJson(path.join(temporary, "role-families.json"), roleFamilies),
        writeJson(path.join(temporary, "search-vocabulary.json"), searchVocabulary),
        writeJson(path.join(temporary, "readiness.json"), readiness),
        writeEvidenceKnowledgeBase(temporary, knowledge),
        writeJson(path.join(temporary, "manifest.json"), manifest),
      ]);
      await rename(temporary, runDirectory);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  await writeJson(path.join(candidateRunRoot, "current.json"), {
    evidenceRunId,
    directory: path.posix.join("evidence-runs", evidenceRunId),
    readiness,
  });
  return { manifest, directory: runDirectory };
}

function sourceSnapshot(candidateId: string, source: CandidateSource): SourceSnapshot {
  const contentHash =
    source.kind === "cv" ? "" : source.contentHash || stableHash(source.content || "");
  const sourceVersionId =
    source.kind === "cv"
      ? source.id
      : `source-${contentHash.slice(0, 20)}`;
  return {
    sourceId: source.id,
    sourceVersionId,
    candidateId,
    kind: canonicalSourceKind(source.kind),
    originalUriOrName: source.url || source.name,
    contentHash,
    retrievedAt: source.addedAt,
    parserVersion:
      source.kind === "cv" ? "direct-cv-read" : SOURCE_PARSER_VERSION,
    accessPolicy:
      source.url ? "public" : "local_only",
    mimeType: source.kind === "cv" ? "" : "text/plain",
    size: Buffer.byteLength(source.content || ""),
    metadata: {
      displayName: source.name,
      profileField: source.profileField || null,
      originalFile: source.originalFile || null,
      rawRepresentationAvailable: false,
      renderedRepresentationAvailable: false,
    },
  };
}

async function persistSourceSnapshots(
  dataRoot: string,
  sources: CandidateSource[],
  snapshots: SourceSnapshot[],
) {
  for (const snapshot of snapshots) {
    const directory = path.join(
      dataRoot,
      "job-search",
      "source-snapshots",
      snapshot.candidateId,
      snapshot.sourceVersionId,
    );
    if (await exists(directory)) continue;
    const source = sources.find((item) => item.id === snapshot.sourceId)!;
    const temporary = `${directory}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(temporary, { recursive: true });
    try {
      const representations: Promise<unknown>[] = [
        writeJson(path.join(temporary, "snapshot.json"), snapshot),
        writeFile(path.join(temporary, "content.txt"), source.content || "", "utf8"),
      ];
      await Promise.all(representations);
      await mkdir(path.dirname(directory), { recursive: true });
      await rename(temporary, directory);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (!(await exists(directory))) throw error;
    }
  }
}

function sourceBlocks(source: CandidateSource, snapshot: SourceSnapshot): SourceBlock[] {
  const lines = (source.content || "").split("\n");
  const blocks: SourceBlock[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let length = 0;
    while (end < lines.length && (length < 12_000 || end === start)) {
      length += lines[end].length + 1;
      end += 1;
    }
    const text = lines.slice(start, end).join("\n");
    const locator = `lines ${start + 1}-${end}`;
    blocks.push({
      blockId: `block-${stableHash(`${snapshot.sourceVersionId}:${locator}:${text}`).slice(0, 20)}`,
      sourceId: source.id,
      sourceVersionId: snapshot.sourceVersionId,
      locator,
      contentHash: stableHash(text),
      text,
    });
    start = end;
  }
  return blocks;
}

function auditClaims(
  workspace: JobSearchWorkspace,
  analysis: CandidateAnalysisResult,
  snapshots: SourceSnapshot[],
): EvidenceClaim[] {
  const sourceById = new Map(workspace.sources.map((source) => [source.id, source]));
  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.sourceId, snapshot]));
  const drafts = analysis.sourceInsights.flatMap((group) =>
    group.claims?.length
      ? group.claims
      : group.insights.map((insight): EvidenceClaimDraft => ({
          action: insight.summary,
          capability: insight.title,
          workContexts: [],
          toolsMethods: insight.skills,
          credentials: [],
          ownership: "unknown",
          maturity: "unknown",
          scope: "unknown",
          startDate: "",
          endDate: "",
          outcomes: [],
          sourceEvidence: [
            {
              sourceId: group.sourceId,
              locator: "source insight",
              quote: insight.evidence,
            },
          ],
          // Insight-derived claims carry a verbatim evidence quote. Start them
          // as supported and let the exact-quote auditor below downgrade
          // any quote that cannot be found in the immutable source snapshot.
          supportStatus: "supported",
          confidence: 0.75,
          limitations: ["Derived from a source insight; exact quote audit required"],
        })),
  );
  const claimsByKey = new Map<string, EvidenceClaim>();
  for (const draft of drafts) {
    const action = clean(draft.action);
    const capability = clean(draft.capability);
    if (!action || !capability) continue;
    let supportStatus = draft.supportStatus;
    const sourceRefs = draft.sourceEvidence.flatMap((evidence): SourceRef[] => {
      const source = sourceById.get(evidence.sourceId);
      const snapshot = snapshotById.get(evidence.sourceId);
      if (!source || !snapshot || !clean(evidence.quote)) return [];
      const quote = clean(evidence.quote);
      const exact = locateQuote(source.content || "", quote);
      if (!exact && supportStatus === "supported")
        supportStatus = "weakly_supported";
      return [{
        sourceId: source.id,
        sourceVersionId: snapshot.sourceVersionId,
        locator:
          sourceSpecificLocator(source, exact) ||
          exact ||
          clean(evidence.locator) ||
          "unresolved locator",
        quote,
        quoteHash: stableHash(quote),
      }];
    });
    if (sourceRefs.length === 0) supportStatus = "unverified";
    const key = normalizeKey(
      `${action}|${capability}|${draft.ownership}|${draft.maturity}|${draft.scope}`,
    );
    const candidate: EvidenceClaim = {
      claimId: `claim-${stableHash(`${workspace.candidateId}:${key}`).slice(0, 20)}`,
      candidateId: workspace.candidateId,
      experienceId: null,
      action,
      capability,
      workContexts: unique(draft.workContexts),
      toolsMethods: unique(draft.toolsMethods),
      credentials: unique(draft.credentials),
      ownership: draft.ownership,
      maturity: draft.maturity,
      scope: draft.scope,
      startDate: clean(draft.startDate) || null,
      endDate: clean(draft.endDate) || null,
      outcomes: draft.outcomes.filter((item) => clean(item.description)),
      sourceRefs,
      supportStatus,
      confidence: clamp01(draft.confidence),
      limitations: unique(draft.limitations),
      status: supportStatus === "contradicted" ? "contradicted" : "active",
    };
    const existing = claimsByKey.get(key);
    if (!existing) claimsByKey.set(key, candidate);
    else {
      existing.sourceRefs = uniqueObjects(
        [...existing.sourceRefs, ...candidate.sourceRefs],
        (item) => `${item.sourceVersionId}:${item.locator}:${item.quoteHash}`,
      );
      existing.workContexts = unique([...existing.workContexts, ...candidate.workContexts]);
      existing.toolsMethods = unique([...existing.toolsMethods, ...candidate.toolsMethods]);
      existing.credentials = unique([...existing.credentials, ...candidate.credentials]);
      existing.limitations = unique([...existing.limitations, ...candidate.limitations]);
      existing.outcomes = uniqueObjects(
        [...existing.outcomes, ...candidate.outcomes],
        (item) => `${item.description}:${item.metric}:${item.value}`,
      );
      existing.confidence = Math.max(existing.confidence, candidate.confidence);
      existing.supportStatus = strongerSupport(
        existing.supportStatus,
        candidate.supportStatus,
      );
    }
  }
  return [...claimsByKey.values()];
}

function aggregateCapabilities(
  claims: EvidenceClaim[],
  analysis: CandidateAnalysisResult,
): Capability[] {
  const groups = new Map<string, EvidenceClaim[]>();
  const seedNames = unique(
    (analysis.roleFamilies || []).flatMap((role) => role.leadingCapabilities),
  ).filter(isReusableCapabilityName);
  const activeClaims = claims.filter((item) => item.status === "active");
  if (seedNames.length > 0) {
    for (const seed of seedNames) {
      const matches = activeClaims
        .map((claim) => ({
          claim,
          score: Math.max(
            phraseSimilarity(seed, claim.capability),
            ...claim.toolsMethods.map((tool) => phraseSimilarity(seed, tool)),
            phraseSimilarity(seed, claim.action),
          ),
        }))
        .filter((item) => item.score >= 0.34)
        .sort((left, right) => right.score - left.score)
        .map((item) => item.claim);
      if (matches.length > 0) groups.set(normalizeKey(seed), matches);
    }
  } else {
    for (const claim of activeClaims.filter((item) => isReusableCapabilityName(item.capability))) {
      const key = normalizeKey(claim.capability);
      groups.set(key, [...(groups.get(key) || []), claim]);
    }
  }
  return [...groups.entries()].map(([key, group]) => {
    const independentSources = new Set(
      group.flatMap((claim) => claim.sourceRefs.map((ref) => ref.sourceVersionId)),
    ).size;
    const averageConfidence =
      group.reduce((total, claim) => total + claim.confidence, 0) / group.length;
    const supportedShare =
      group.filter((claim) => claim.supportStatus === "supported").length /
      group.length;
    const outcomeShare = group.some((claim) => claim.outcomes.length > 0) ? 1 : 0;
    return {
      capabilityId: `capability-${stableHash(key).slice(0, 20)}`,
      name: seedNames.find((seed) => normalizeKey(seed) === key) || group[0].capability,
      claimIds: unique(group.map((claim) => claim.claimId)),
      workContexts: unique(group.flatMap((claim) => claim.workContexts)),
      toolsMethods: unique(group.flatMap((claim) => claim.toolsMethods)),
      ownershipMax: rankedMax(group.map((claim) => claim.ownership), OWNERSHIP_RANK),
      maturityMax: rankedMax(group.map((claim) => claim.maturity), MATURITY_RANK),
      scopeMax: rankedMax(group.map((claim) => claim.scope), SCOPE_RANK),
      recency: recency(group.map((claim) => claim.endDate).filter(Boolean) as string[]),
      evidenceStrength: Number(
        clamp01(
          averageConfidence * 0.55 +
            supportedShare * 0.25 +
            Math.min(1, independentSources / 2) * 0.1 +
            outcomeShare * 0.1,
        ).toFixed(3),
      ),
      outcomes: uniqueObjects(
        group.flatMap((claim) => claim.outcomes),
        (item) => `${item.description}:${item.metric}:${item.value}`,
      ),
      directAliases: unique([
        seedNames.find((seed) => normalizeKey(seed) === key) || group[0].capability,
        ...group.map((claim) => claim.capability),
      ]),
      adjacentAliases: [],
    };
  });
}

function canonicalUnknowns(
  analysis: CandidateAnalysisResult,
  workspace: JobSearchWorkspace,
): CandidateUnknown[] {
  const supplied = analysis.unknowns || analysis.sourceInsights.flatMap((item) => item.unknowns || []);
  const educationIsKnown = workspace.sources.some((source) =>
    /\b(?:master(?:'s)?|bachelor(?:'s)?|degree|university|education)\b/i.test(
      source.content || "",
    ),
  );
  const employmentHistoryIsKnown = workspace.sources.some((source) =>
    /\b(?:19|20)\d{2}\b[\s\S]{0,160}\b(?:engineer|architect|developer|lead|manager|consultant|administrator|founder)\b|\b(?:engineer|architect|developer|lead|manager|consultant|administrator|founder)\b[\s\S]{0,160}\b(?:19|20)\d{2}\b/i.test(
      source.content || "",
    ),
  );
  const profileUnknowns = [
    !workspace.profile.workAuthorization
      ? { field: "work_authorization", reason: "Candidate work authorization is not confirmed", materiality: "feasibility" as const }
      : undefined,
  ].filter(Boolean) as Array<{
    field: string;
    reason: string;
    materiality: CandidateUnknown["materiality"];
  }>;
  return uniqueObjects(
    // uniqueObjects keeps the last value for a canonical key. Put profile
    // feasibility unknowns last so a model cannot downgrade a hard matching
    // constraint such as work authorization to an ordinary search unknown.
    [...supplied, ...profileUnknowns]
      .filter(
        (item) =>
          !(educationIsKnown && canonicalFieldKey(item.field) === "education") &&
          !(
            employmentHistoryIsKnown &&
            ["employmenthistory", "employmentdates", "datesortenure", "yearsexperience"].includes(
              canonicalFieldKey(item.field),
            )
          ),
      )
      .map((item) => {
      const sourceIds =
        "sourceIds" in item && Array.isArray(item.sourceIds)
          ? item.sourceIds.filter((value): value is string => typeof value === "string")
          : [];
      return {
        unknownId: `unknown-${stableHash(`${item.field}:${item.reason}`).slice(0, 20)}`,
        field: clean(item.field),
        reason: clean(item.reason),
        materiality: item.materiality,
        sourceIds: unique(sourceIds),
      };
    }),
    (item) => canonicalFieldKey(item.field),
  );
}

function canonicalContradictions(
  analysis: CandidateAnalysisResult,
): CandidateContradiction[] {
  return (analysis.contradictions || []).map((item) => ({
    contradictionId: `contradiction-${stableHash(JSON.stringify(item)).slice(0, 20)}`,
    field: clean(item.field),
    values: item.values,
    explanation: clean(item.explanation),
    status: "open",
  }));
}

function canonicalProhibitedInferences(
  analysis: CandidateAnalysisResult,
  sources: CandidateSource[],
): ProhibitedInference[] {
  const supplied = [
    ...(analysis.prohibitedInferences || []),
    ...analysis.sourceInsights.flatMap((item) => item.prohibitedInferences || []),
  ];
  const defaults = [
    {
      rule: "A job title does not prove a skill, ownership level, or scope.",
      reason: "Only explicit source evidence may support these fields.",
      sourceIds: [] as string[],
    },
    ...(sources.some((source) => source.kind === "repository" || source.kind === "github")
      ? [
          {
            rule: "Repository access or ownership does not prove authorship of all code.",
            reason: "Authorship requires commit evidence or candidate confirmation.",
            sourceIds: sources
              .filter((source) => source.kind === "repository" || source.kind === "github")
              .map((source) => source.id),
          },
          {
            rule: "Implemented repository code does not prove production operation or scale.",
            reason: "Deployment, monitoring, usage, performance, or operations evidence is required.",
            sourceIds: sources
              .filter((source) => source.kind === "repository" || source.kind === "github")
              .map((source) => source.id),
          },
        ]
      : []),
  ];
  return uniqueObjects(
    [...supplied, ...defaults].map((item) => ({
      inferenceId: `inference-${stableHash(item.rule).slice(0, 20)}`,
      rule: clean(item.rule),
      reason: clean(item.reason),
      sourceIds: unique(item.sourceIds),
    })),
    (item) => normalizeKey(item.rule),
  );
}

function canonicalRoleFamilies(
  analysis: CandidateAnalysisResult,
  capabilities: Capability[],
  profile: CandidateProfile,
): RoleFamily[] {
  const byName = new Map(
    capabilities.map((capability) => [normalizeKey(capability.name), capability]),
  );
  const drafts = analysis.roleFamilies || [];
  if (drafts.length === 0 && profile.headline && capabilities.length > 0) {
    drafts.push({
      canonicalTitle: profile.headline,
      titleAliases: [profile.headline],
      problemPhrases: capabilities.slice(0, 5).map((item) => item.name),
      leadingCapabilities: capabilities.slice(0, 5).map((item) => item.name),
      roleClass: "direct",
      geographyLanguageVariants: [],
      confidence: 0.5,
    });
  }
  return drafts.flatMap((draft): RoleFamily[] => {
    const leadingCapabilityIds = unique(
      draft.leadingCapabilities.flatMap((name) => {
        const exact = byName.get(normalizeKey(name));
        if (exact) return [exact.capabilityId];
        return capabilities
          .map((capability) => ({
            id: capability.capabilityId,
            score: phraseSimilarity(name, capability.name),
          }))
          .filter((item) => item.score >= 0.34)
          .sort((left, right) => right.score - left.score)
          .slice(0, 3)
          .map((item) => item.id);
      }),
    );
    if (!clean(draft.canonicalTitle) || leadingCapabilityIds.length === 0) return [];
    return [{
      roleFamilyId: `role-${stableHash(`${draft.roleClass}:${draft.canonicalTitle}`).slice(0, 20)}`,
      canonicalTitle: clean(draft.canonicalTitle),
      titleAliases: unique(draft.titleAliases),
      problemPhrases: unique(draft.problemPhrases),
      leadingCapabilityIds,
      roleClass: draft.roleClass,
      geographyLanguageVariants: draft.geographyLanguageVariants,
      confidence: clamp01(draft.confidence),
    }];
  });
}

function canonicalSearchVocabulary(
  analysis: CandidateAnalysisResult,
  capabilities: Capability[],
  roles: RoleFamily[],
): SearchVocabularyDraft {
  const supplied = analysis.searchVocabulary;
  return {
    titleAliases: unique([
      ...(supplied?.titleAliases || []),
      ...roles.flatMap((role) => [role.canonicalTitle, ...role.titleAliases]),
    ]).slice(0, 30),
    evidenceIntersections: unique(supplied?.evidenceIntersections || []).slice(0, 20),
    problemPhrases: unique([
      ...(supplied?.problemPhrases || []),
      ...roles.flatMap((role) => role.problemPhrases),
    ]).slice(0, 30),
    toolsMethodsStandards: unique([
      ...(supplied?.toolsMethodsStandards || []),
      ...[...capabilities]
        .sort((left, right) => right.evidenceStrength - left.evidenceStrength)
        .slice(0, 20)
        .flatMap((capability) => capability.toolsMethods),
    ])
      .filter(isReusableSearchTerm)
      .slice(0, 60),
    adjacentDialects: unique(supplied?.adjacentDialects || []).slice(0, 20),
    seniorityOwnershipModifiers: unique(
      supplied?.seniorityOwnershipModifiers || [],
    ).slice(0, 12),
    geographyLanguageVariants: unique(
      supplied?.geographyLanguageVariants || [],
    ).slice(0, 20),
    negativeTerms: unique(supplied?.negativeTerms || []).slice(0, 20),
  };
}

function candidateConstraints(profile: CandidateProfile): CandidateConstraints {
  const modes = splitValues(profile.workplace);
  const targetLocations = splitValues(profile.targetLocations);
  const remoteRegions = modes.includes("Remote")
    ? ["Worldwide", "Europe", "European Union", "EMEA"]
    : [];
  const salary = profile.salaryExpectation.match(
    /^(EUR|USD|GBP|CHF|CZK|PLN|CAD|AUD)\s+(\d+(?:\.\d+)?)\s*(?:\/(year|month|hour))?/i,
  );
  return {
    locations: {
      base: constraint(profile.location || null, "soft"),
      acceptableHubs: constraint(targetLocations.length ? targetLocations : null, targetLocations.length ? "hard" : "unknown"),
      remoteRegions: constraint(remoteRegions.length ? remoteRegions : null, remoteRegions.length ? "hard" : "unknown"),
      relocation: constraint(null, "unknown"),
    },
    employment: {
      types: constraint(
        splitValues(profile.employmentTypes).length
          ? splitValues(profile.employmentTypes)
          : null,
        profile.employmentTypes ? "hard" : "unknown",
      ),
      workAuthorization: constraint(
        profile.workAuthorization ? [profile.workAuthorization] : null,
        profile.workAuthorization ? "hard" : "unknown",
      ),
      earliestStart: constraint(
        profile.startDate || null,
        profile.startDate ? "hard" : "unknown",
      ),
    },
    compensation: {
      floor: constraint(
        salary
          ? {
              amount: Number(salary[2]),
              currency: salary[1].toUpperCase(),
              period: (salary[3]?.toLowerCase() || "year") as "year" | "month" | "hour",
            }
          : null,
        salary ? "hard" : "unknown",
      ),
    },
    languages: profile.languages.map((value) => {
      const match = value.match(/^(.+?)(?:\s*\(([^)]+)\))?$/);
      return {
        name: clean(match?.[1] || value),
        level: languageLevel(match?.[2] || ""),
        evidenceRef: null,
      };
    }),
  };
}

function evidenceReadiness(input: {
  snapshots: SourceSnapshot[];
  blocks: SourceBlock[];
  claims: EvidenceClaim[];
  capabilities: Capability[];
  roleFamilies: RoleFamily[];
  unknowns: CandidateUnknown[];
  contradictions: CandidateContradiction[];
  additionalBlockers: string[];
}): EvidenceReadiness {
  const supportedClaims = input.claims.filter(
    (claim) =>
      claim.supportStatus === "supported" && claim.sourceRefs.length > 0,
  );
  const blockers: string[] = [...input.additionalBlockers];
  if (input.snapshots.length === 0) blockers.push("No candidate evidence sources were ingested");
  if (input.claims.length === 0) blockers.push("No atomic evidence claims were extracted");
  if (input.capabilities.length === 0) blockers.push("No capabilities were aggregated from claims");
  if (input.roleFamilies.length === 0) blockers.push("No evidence-backed role families were generated");
  if (supportedClaims.length === 0)
    blockers.push("No positive claim has an exact supported source reference");
  const warnings: string[] = [];
  const weakClaims = input.claims.filter(
    (claim) => claim.supportStatus !== "supported",
  ).length;
  if (weakClaims) warnings.push(`${weakClaims} claims require evidence review`);
  if (!input.roleFamilies.some((role) => role.roleClass === "adjacent"))
    warnings.push("No credible adjacent role family was generated");
  if (input.contradictions.length)
    warnings.push(`${input.contradictions.length} evidence contradictions remain open`);
  return {
    readyForSearch: blockers.length === 0,
    blockers,
    warnings,
    counts: {
      sources: input.snapshots.length,
      sourceBlocks: input.blocks.length,
      claims: input.claims.length,
      supportedClaims: supportedClaims.length,
      capabilities: input.capabilities.length,
      roleFamilies: input.roleFamilies.length,
      unknowns: input.unknowns.length,
      contradictions: input.contradictions.length,
    },
  };
}

function claimTimeline(claims: EvidenceClaim[]) {
  return claims
    .filter((claim) => claim.startDate || claim.endDate)
    .map((claim) => ({
      claimId: claim.claimId,
      capability: claim.capability,
      startDate: claim.startDate,
      endDate: claim.endDate,
    }))
    .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));
}

function locateQuote(content: string, quote: string) {
  const direct = content.indexOf(quote);
  if (direct >= 0) return lineLocator(content, direct, direct + quote.length);
  const normalizedQuote = quote.replace(/\s+/g, " ").trim();
  if (!normalizedQuote) return "";
  const lines = content.split("\n");
  for (let start = 0; start < lines.length; start += 1) {
    let text = "";
    for (let end = start; end < Math.min(lines.length, start + 12); end += 1) {
      text = `${text} ${lines[end]}`.replace(/\s+/g, " ").trim();
      if (text.includes(normalizedQuote)) return `lines ${start + 1}-${end + 1}`;
      if (text.length > normalizedQuote.length * 3 + 500) break;
    }
  }
  return "";
}

function lineLocator(content: string, start: number, end: number) {
  const startLine = content.slice(0, start).split("\n").length;
  const endLine = content.slice(0, end).split("\n").length;
  return `lines ${startLine}-${endLine}`;
}

function sourceSpecificLocator(source: CandidateSource, locator: string) {
  if (!locator) return "";
  const match = locator.match(/^lines (\d+)-(\d+)$/);
  if (!match) return "";
  const sourceStart = Number(match[1]);
  const sourceEnd = Number(match[2]);
  const lines = (source.content || "").split("\n");
  if (source.kind === "cv") {
    let page = 1;
    let pageStart = 1;
    for (let index = 0; index < sourceStart - 1; index += 1) {
      const pageBreak = lines[index]?.match(/^--\s*(\d+)\s+of\s+\d+\s*--$/i);
      if (pageBreak) {
        page = Number(pageBreak[1]) + 1;
        pageStart = index + 2;
      }
    }
    const crossesPage = lines
      .slice(sourceStart - 1, sourceEnd)
      .some((line) => /^--\s*\d+\s+of\s+\d+\s*--$/i.test(line));
    if (!crossesPage)
      return `page ${page}, lines ${sourceStart - pageStart + 1}-${sourceEnd - pageStart + 1}`;
  }
  if (source.kind === "portfolio" || source.kind === "webpage") {
    let pageUrl = source.url || "";
    for (let index = 0; index < sourceStart; index += 1) {
      const pageMatch = lines[index]?.match(/^Page:\s*(https?:\/\/\S+)/i);
      if (pageMatch) pageUrl = pageMatch[1];
    }
    if (pageUrl) return `${pageUrl}; ${locator}`;
  }
  if (source.kind !== "repository") return "";
  let commit = "unknown";
  let file = "";
  let fileHeaderLine = 0;
  for (let index = 0; index < sourceStart; index += 1) {
    const commitMatch = lines[index]?.match(/^Repository commit:\s*(\S+)/i);
    if (commitMatch) commit = commitMatch[1];
    const fileMatch = lines[index]?.match(/^### File:\s*(.+)$/i);
    if (fileMatch) {
      file = fileMatch[1].trim();
      fileHeaderLine = index + 1;
    }
  }
  if (!file) return `commit ${commit}; ${locator}`;
  const fileStart = Math.max(1, sourceStart - fileHeaderLine);
  const fileEnd = Math.max(fileStart, sourceEnd - fileHeaderLine);
  return `commit ${commit}; ${file}:${fileStart}-${fileEnd}`;
}

function canonicalSourceKind(kind: CandidateSource["kind"]): SourceSnapshot["kind"] {
  if (kind === "cv" || kind === "document" || kind === "repository") return kind;
  if (kind === "portfolio" || kind === "webpage") return "website";
  return "other";
}

function strongerSupport(
  left: EvidenceClaim["supportStatus"],
  right: EvidenceClaim["supportStatus"],
) {
  const order: EvidenceClaim["supportStatus"][] = [
    "contradicted",
    "unverified",
    "weakly_supported",
    "supported",
  ];
  return order.indexOf(left) >= order.indexOf(right) ? left : right;
}

function rankedMax<T extends string>(values: T[], order: readonly T[]): T {
  return values.reduce(
    (best, value) =>
      order.indexOf(value) > order.indexOf(best) ? value : best,
    values[0] || order[0],
  );
}

function recency(dates: string[]) {
  const timestamps = dates
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  if (!timestamps.length) return null;
  const years = (Date.now() - Math.max(...timestamps)) / (365.25 * 24 * 60 * 60 * 1000);
  return Number(Math.exp(-Math.max(0, years) / 5).toFixed(3));
}

function constraint<T>(
  value: T | null,
  mode: "hard" | "soft" | "unknown",
) {
  return { value, mode, evidenceRef: null };
}

function languageLevel(value: string): CandidateConstraints["languages"][number]["level"] {
  const normalized = value.toLowerCase();
  if (normalized.includes("native")) return "native";
  if (normalized.includes("professional") || normalized.includes("fluent"))
    return "professional";
  if (normalized.includes("conversational") || normalized.includes("intermediate"))
    return "conversational";
  if (normalized.includes("basic") || normalized.includes("beginner")) return "basic";
  return "unknown";
}

function splitValues(value: string) {
  return unique(value.split(/[,|]/).map(clean));
}

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeKey(value: string) {
  return clean(value).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function canonicalFieldKey(value: string) {
  return normalizeKey(value).replace(/[^a-z0-9]+/g, "");
}

function phraseSimilarity(left: string, right: string) {
  const tokens = (value: string) =>
    new Set(
      normalizeKey(value)
        .split(/[^a-z0-9+#.]+/)
        .filter((token) => token.length > 2),
    );
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / Math.min(leftTokens.size, rightTokens.size);
}

function isReusableSearchTerm(value: string) {
  const term = clean(value);
  return (
    term.length >= 2 &&
    term.length <= 64 &&
    !/[(){}=]|\b(?:function|calldata|0x[0-9a-f]+|\d+(?:\.\d+)?%)\b/i.test(term) &&
    !/^[A-Za-z_$][\w$]*\([^)]*\)$/.test(term)
  );
}

function isReusableCapabilityName(value: string) {
  const term = clean(value);
  return (
    isReusableSearchTerm(term) &&
    term.length <= 80 &&
    !/\b(?:candidate|name|email|phone|degree|university|identified as)\b/i.test(term) &&
    !/\b\d[\d,.]*\b/.test(term)
  );
}

function unique(values: string[]) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function uniqueObjects<T>(values: T[], key: (value: T) => string) {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function stableHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(value: string) {
  return access(value).then(
    () => true,
    () => false,
  );
}

async function writeJson(file: string, value: unknown) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(file: string, values: unknown[]) {
  await writeFile(
    file,
    values.length ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "",
    "utf8",
  );
}

export async function readCurrentEvidenceRun(dataRoot: string, candidateId: string) {
  const root = path.join(dataRoot, "job-search", "runs", candidateId, "evidence-runs");
  const current = JSON.parse(await readFile(path.join(root, "current.json"), "utf8")) as {
    evidenceRunId: string;
  };
  const directory = path.join(root, current.evidenceRunId);
  const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
  ) as EvidenceRunManifest;
  return { manifest, directory };
}

export async function readCurrentEvidenceModel(dataRoot: string, candidateId: string) {
  const current = await readCurrentEvidenceRun(dataRoot, candidateId);
  return readEvidenceModelFromDirectory(current.manifest, current.directory);
}

export async function readEvidenceModel(
  dataRoot: string,
  candidateId: string,
  evidenceRunId: string,
) {
  const root = path.join(dataRoot, "job-search", "runs", candidateId, "evidence-runs");
  const directory = path.join(root, evidenceRunId);
  const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
  ) as EvidenceRunManifest;
  return readEvidenceModelFromDirectory(manifest, directory);
}

async function readEvidenceModelFromDirectory(
  manifest: EvidenceRunManifest,
  directory: string,
) {
  const [claims, capabilities, constraints, unknowns, contradictions, prohibitedInferences, profileEvidence, roleFamilies, searchVocabulary, readiness] =
    await Promise.all([
      readJsonlFile(path.join(directory, "claims.jsonl")),
      readJsonFile(path.join(directory, "capabilities.json")),
      readJsonFile(path.join(directory, "constraints.json")),
      readJsonFile(path.join(directory, "unknowns.json")),
      readJsonFile(path.join(directory, "contradictions.json")),
      readJsonFile(path.join(directory, "prohibited-inferences.json")),
      readJsonFile(path.join(directory, "profile-evidence.json")),
      readJsonFile(path.join(directory, "role-families.json")),
      readJsonFile(path.join(directory, "search-vocabulary.json")),
      readJsonFile(path.join(directory, "readiness.json")),
    ]);
  return {
    manifest,
    claims,
    capabilities,
    constraints,
    unknowns,
    contradictions,
    prohibitedInferences,
    profileEvidence,
    roleFamilies,
    searchVocabulary,
    readiness,
  };
}

async function readJsonFile(file: string) {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

async function readJsonlFile(file: string) {
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}
