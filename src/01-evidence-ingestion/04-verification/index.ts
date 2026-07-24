import { mkdir, writeFile } from "node:fs/promises";
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
  const { dataRoot, workspace, analysis, sourceIdsToAnalyze } = input;

  // 1. Audit and apply only source-derived profile values with exact provenance.
  const profileEvidence = auditProfileEvidence({
    baseline: workspace.profile,
    proposed: analysis.profile,
    sources: workspace.sources,
    evidence: analysis.profileEvidence || [],
  });
  applyCandidateAnalysis(workspace, analysis, profileEvidence);

  // 2. Persist one human-readable knowledge note per analyzed source.
  await persistKnowledgeNotes(
    dataRoot,
    workspace,
    analysis,
    sourceIdsToAnalyze,
  );

  // 3. Deterministically audit quotes and write the canonical evidence model.
  const evidenceRun = await persistCanonicalEvidenceRun({
    dataRoot,
    workspace,
    analysis,
    profileEvidence: profileEvidence.verified,
    profileEvidenceBlockers: profileEvidence.blockers,
  });

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
    if (!analyzedSourceIds.has(source.id)) continue;
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
    if (
      !confirmedFields.has(key) ||
      !workspace.profile[key as keyof typeof workspace.profile]
    )
      (workspace.profile as unknown as Record<string, string>)[key] =
        value.trim();
  }

  for (const group of result.sourceInsights) {
    const source = workspace.sources.find((item) => item.id === group.sourceId);
    if (source) source.insights = group.insights;
  }
}

async function persistKnowledgeNotes(
  dataRoot: string,
  workspace: JobSearchWorkspace,
  analysis: CandidateAnalysisResult,
  sourceIdsToAnalyze: ReadonlySet<string>,
) {
  const knowledgeDirectory = path.join(
    dataRoot,
    "job-search",
    "runs",
    workspace.candidateId,
    "knowledge",
  );
  await mkdir(knowledgeDirectory, { recursive: true });
  const resultBySource = new Map(
    analysis.sourceInsights.map((group) => [group.sourceId, group]),
  );

  for (const source of workspace.sources) {
    if (sourceIdsToAnalyze.has(source.id)) {
      const group = resultBySource.get(source.id);
      if (group) {
        const filename = knowledgeFilename(source);
        source.knowledgePath = path.posix.join(
          "job-search",
          "runs",
          workspace.candidateId,
          "knowledge",
          filename,
        );
        await writeFile(
          path.join(knowledgeDirectory, filename),
          renderKnowledgeMarkdown(source, group.knowledgeMarkdown),
          "utf8",
        );
      }
    }

    if (source.knowledgePath)
      for (const insight of source.insights)
        insight.detailRef = source.knowledgePath;
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

function knowledgeFilename(source: JobSearchWorkspace["sources"][number]) {
  const slug =
    source.name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "source";
  const id = source.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12);
  return `${slug}-${id}.md`;
}

function renderKnowledgeMarkdown(
  source: JobSearchWorkspace["sources"][number],
  generated: string | undefined,
) {
  const details =
    generated?.trim() ||
    source.insights
      .map(
        (insight) =>
          `## ${insight.title}\n\n${insight.summary}\n\n**Source evidence:** ${insight.evidence}\n\n**Skills:** ${insight.skills.join(", ") || "Not specified"}`,
      )
      .join("\n\n");
  const metadata = [
    `- Source ID: \`${source.id}\``,
    `- Kind: ${source.kind}`,
    source.url ? `- URL: ${source.url}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `# ${source.name}\n\n${metadata}\n\n${
    details || "No job-relevant detail was identified in this source."
  }\n`;
}

function isPlausiblePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  return (
    digits.length >= 9 &&
    digits.length <= 15 &&
    !/^\s*\d{4}\s*[-\u2013]\s*\d{4}\s*$/.test(value)
  );
}
