import path from "node:path";
import type { JobSearchWorkspace } from "../../contracts/job-search.js";
import {
  persistCanonicalEvidenceRun,
  type PersistedEvidenceRun,
} from "./evidence-model.js";
import type { CandidateAnalysisResult } from "../types.js";
import {
  auditProfileEvidence,
  type ProfileEvidenceAudit,
} from "./profile-evidence/index.js";
import { knowledgeSourceFilename } from "./knowledge-base/index.js";
import {
  evidenceChunkLimitWarning,
  evidenceSourceLimitMessage,
} from "../chunk-budget.js";

/**
 * Stage 4: apply model output, audit exact quotations, persist the current
 * evidence model, and publish the ready state.
 */
export async function verifyAndPersistEvidence(input: {
  dataRoot: string;
  workspace: JobSearchWorkspace;
  analysis: CandidateAnalysisResult;
  sourceIdsToAnalyze: ReadonlySet<string>;
}): Promise<PersistedEvidenceRun> {
  const { dataRoot, workspace, sourceIdsToAnalyze } = input;
  const analysis = normalizeCandidateAnalysisProfileLists(input.analysis);

  // 1. Audit and apply only source-derived profile values with exact provenance.
  const profileEvidence = auditProfileEvidence({
    baseline: workspace.profile,
    proposed: analysis.profile,
    sources: workspace.sources,
    evidence: analysis.profileEvidence || [],
  });
  applyCandidateAnalysis(workspace, analysis, profileEvidence);

  // 2. Deterministically audit quotes and atomically write both the canonical
  // ledgers and their layered, human-readable knowledge base.
  const evidenceRun = await persistCanonicalEvidenceRun({
    dataRoot,
    workspace,
    analysis,
    profileEvidence: profileEvidence.verified,
    profileEvidenceBlockers: profileEvidence.blockers,
    additionalWarnings: analysis.chunkCoverage
      ? [evidenceChunkLimitWarning(analysis.chunkCoverage)].filter(
          (warning): warning is string => Boolean(warning),
        )
      : [],
  });

  const coverageBySource = new Map(
    analysis.chunkCoverage?.sources.map((coverage) => [
      coverage.sourceId,
      coverage,
    ]) || [],
  );

  // 3. Link each analyzed source to its immutable deep knowledge page.
  for (const source of workspace.sources) {
    if (!sourceIdsToAnalyze.has(source.id)) continue;
    const coverage = coverageBySource.get(source.id);
    if (coverage && coverage.analyzedChunks === 0) continue;
    source.knowledgePath = path.posix.join(
      "job-search",
      "runs",
      workspace.candidateId,
      "evidence-runs",
      evidenceRun.manifest.evidenceRunId,
      "knowledge",
      "sources",
      knowledgeSourceFilename(source),
    );
    for (const insight of source.insights)
      insight.detailRef = source.knowledgePath;
  }

  // 4. Publish readiness and mark every analyzed source complete.
  workspace.intelligence.evidenceRun = {
    id: evidenceRun.manifest.evidenceRunId,
    readyForSearch: evidenceRun.manifest.readiness.readyForSearch,
    blockers: evidenceRun.manifest.readiness.blockers,
    warnings: evidenceRun.manifest.readiness.warnings,
    counts: evidenceRun.manifest.readiness.counts,
  };
  const analyzedSourceIds = new Set(
    analysis.sourceInsights.map((item) => item.sourceId),
  );
  for (const source of workspace.sources) {
    if (
      !sourceIdsToAnalyze.has(source.id) ||
      !analyzedSourceIds.has(source.id)
    )
      continue;
    const coverage = coverageBySource.get(source.id);
    if (
      analysis.chunkCoverage?.limitReached &&
      coverage &&
      coverage.analyzedChunks < coverage.totalChunks
    ) {
      source.status = "needs_review";
      source.analysisRequired = false;
      source.error = evidenceSourceLimitMessage(
        coverage,
        analysis.chunkCoverage,
      );
      continue;
    }
    source.status = "ready";
    source.analysisRequired = false;
    source.error = undefined;
  }
  workspace.intelligence.status = workspace.sources.some(
    (source) => source.status === "processing",
  )
    ? "analyzing"
    : "ready";
  workspace.intelligence.error = undefined;
  workspace.intelligence.progress = undefined;
  advanceProfileSetupAfterAnalysis(workspace);

  return evidenceRun;
}

/**
 * Reader models occasionally return an entire comma-separated list as one
 * skill or language. Treating that list as one profile value makes exact
 * provenance recovery impossible and can block an otherwise grounded run.
 * Normalize at the shared verification boundary so v1, v2, and cached reader
 * output all receive the same deterministic repair.
 */
export function normalizeCandidateAnalysisProfileLists(
  analysis: CandidateAnalysisResult,
): CandidateAnalysisResult {
  return {
    ...analysis,
    profile: {
      ...analysis.profile,
      skills: atomicListValues(analysis.profile.skills),
      languages: atomicListValues(analysis.profile.languages),
    },
    profileEvidence: (analysis.profileEvidence || []).flatMap((item) =>
      item.field === "skills" || item.field === "languages"
        ? atomicListValues([item.value]).map((value) => ({ ...item, value }))
        : [item],
    ),
  };
}

function atomicListValues(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values || []) {
    for (const item of value.split(/[,;|\n\r\u2022]+/u)) {
      const normalized = item.replace(/^[-*]\s*/, "").trim();
      const key = normalized.toLowerCase();
      if (!normalized || seen.has(key)) continue;
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

function applyCandidateAnalysis(
  workspace: JobSearchWorkspace,
  result: CandidateAnalysisResult,
  profileEvidence: ProfileEvidenceAudit,
) {
  workspace.intelligence.threadId = result.threadId;
  workspace.profile.headline = "";
  workspace.profile.summary = "";
  workspace.profile.skills = [];

  const confirmedFields = new Set([
    "name",
    "email",
    "phone",
    "location",
    "salaryExpectation",
    "targetLocations",
    "workplace",
    "employmentTypes",
    "workAuthorization",
    "startDate",
  ]);
  const cvSourceIds = new Set(
    workspace.sources
      .filter((source) => source.kind === "cv")
      .map((source) => source.id),
  );
  for (const [key, value] of Object.entries(result.profile) as Array<
    [keyof typeof result.profile, string | string[]]
  >) {
    if (key === "skills") {
      if (Array.isArray(value))
        workspace.profile.skills = [
          ...new Set(
            value.filter((item) => profileEvidence.supports("skills", item)),
          ),
        ];
      continue;
    }
    if (key === "languages") {
      if (Array.isArray(value) && value.length)
        workspace.profile.languages = [
          ...new Set([
            ...workspace.profile.languages,
            ...value.filter((item) =>
              profileEvidence.supports("languages", item),
            ),
          ]),
        ];
      continue;
    }
    if (typeof value !== "string" || !value.trim()) continue;
    if (
      (key === "name" ||
        key === "email" ||
        key === "phone" ||
        key === "location" ||
        key === "headline" ||
        key === "summary") &&
      !workspace.profile[key] &&
      !profileEvidence.supports(key, value)
    )
      continue;
    if (key === "phone" && !isPlausiblePhone(value)) continue;
    const cvBacked = profileEvidence.verified.some(
      (item) =>
        item.field === key &&
        item.value.trim().toLowerCase() === value.trim().toLowerCase() &&
        cvSourceIds.has(item.sourceId),
    );
    const replacesAuthIdentity =
      (key === "name" || key === "email") &&
      workspace.profileFieldOrigins?.[key] === "auth" &&
      cvBacked;
    if (
      !confirmedFields.has(key) ||
      !workspace.profile[key as keyof typeof workspace.profile] ||
      replacesAuthIdentity
    ) {
      (workspace.profile as unknown as Record<string, string>)[key] =
        value.trim();
      if (
        cvBacked &&
        (key === "name" ||
          key === "email" ||
          key === "linkedin" ||
          key === "github" ||
          key === "website")
      ) {
        workspace.profileFieldOrigins ??= {};
        workspace.profileFieldOrigins[key] = "cv";
      }
    }
  }

  for (const group of result.sourceInsights) {
    const source = workspace.sources.find((item) => item.id === group.sourceId);
    if (source) source.insights = group.insights;
  }
}

function advanceProfileSetupAfterAnalysis(workspace: JobSearchWorkspace) {
  if (!workspace.sources.some((source) => source.kind === "cv")) return;
  const evidenceReady =
    workspace.intelligence.status === "ready" &&
    !workspace.sources.some(
      (source) => source.status === "processing" || source.analysisRequired,
    );
  if (!evidenceReady) return;
  const basicsReady =
    Boolean(workspace.profile.name.trim()) &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(workspace.profile.email.trim());
  workspace.profileSetupStep = Math.max(
    workspace.profileSetupStep ?? 1,
    basicsReady ? 3 : 2,
  ) as 2 | 3 | 4;
}

function isPlausiblePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  return (
    digits.length >= 9 &&
    digits.length <= 15 &&
    !/^\s*\d{4}\s*[-\u2013]\s*\d{4}\s*$/.test(value)
  );
}
