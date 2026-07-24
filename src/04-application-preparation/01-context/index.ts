import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ApplicationDraft,
  JobOpportunity,
  JobSearchWorkspace,
} from "../../contracts/job-search.js";
import type { SourceDocument } from "../types.js";

/** Stage 1: assemble the bounded evidence packet for one application. */
export async function buildApplicationContext(
  workspace: JobSearchWorkspace,
  application: ApplicationDraft,
  dataRoot: string,
) {
  const job = requireJob(workspace, application.jobId);
  return {
    applicationId: application.id,
    candidate: {
      name: workspace.profile.name,
      headline: workspace.profile.headline,
      summary: workspace.profile.summary,
      skills: workspace.profile.skills,
      languages: workspace.profile.languages,
    },
    job,
    sourceEvidence: workspace.sources.flatMap((source) =>
      source.insights.map((insight) => ({
        source: source.name,
        title: insight.title,
        summary: insight.summary,
        evidence: insight.evidence,
      })),
    ),
    sourceDocuments: await loadRelevantKnowledgeDocuments(
      workspace,
      application,
      dataRoot,
    ),
    employerFields: application.formFields.map((field) => ({
      fieldId: field.id,
      label: field.label,
      type: field.type,
      required: field.required,
      options: field.options ?? [],
      currentValue: field.value,
    })),
    requiresCoverLetter: application.formFields.some(
      (field) => field.canonicalKey === "cover_letter" || field.id === "cover",
    ),
    currentCoverLetter: application.coverLetter,
  };
}

export async function loadRelevantKnowledgeDocuments(
  workspace: JobSearchWorkspace,
  application: ApplicationDraft,
  dataRoot: string,
): Promise<SourceDocument[]> {
  const maxTotal = 180_000;
  const maxPerSource = 80_000;
  let remaining = maxTotal;
  const job = requireJob(workspace, application.jobId);
  const citedSourceIds = new Set(
    job.requirementMatches
      .filter((match) => match.status !== "missing")
      .flatMap((match) => match.evidence.map((evidence) => evidence.sourceId)),
  );
  const selected = citedSourceIds.size
    ? workspace.sources.filter((source) => citedSourceIds.has(source.id))
    : rankSourcesForJob(workspace, job).slice(0, 4);
  const documents: SourceDocument[] = [];
  for (const source of selected) {
    if (remaining <= 0) break;
    const detailRef =
      source.knowledgePath ||
      source.insights.find((insight) => insight.detailRef)?.detailRef;
    const content = detailRef ? await readKnowledgeFile(dataRoot, detailRef) : "";
    if (!content) continue;
    const clipped = content.slice(0, Math.min(maxPerSource, remaining));
    remaining -= clipped.length;
    documents.push({
      sourceId: source.id,
      source: source.name,
      kind: source.kind,
      url: source.url,
      detailRef,
      content: clipped,
      truncated: clipped.length < content.length,
    });
  }
  return documents;
}

async function readKnowledgeFile(dataRoot: string, detailRef: string) {
  const root = path.resolve(dataRoot);
  const target = path.resolve(root, detailRef);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return readFile(target, "utf8").catch(() => "");
}

function rankSourcesForJob(workspace: JobSearchWorkspace, job: JobOpportunity) {
  const terms = new Set(
    `${job.title} ${job.summary} ${job.description || ""} ${job.requirements.join(" ")}`
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((term) => term.length >= 3),
  );
  return workspace.sources
    .map((source, index) => ({
      source,
      index,
      score: source.insights.reduce((total, insight) => {
        const value = `${insight.title} ${insight.summary} ${insight.skills.join(" ")}`.toLowerCase();
        return total + [...terms].filter((term) => value.includes(term)).length;
      }, 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ source }) => source);
}

export function requireApplication(workspace: JobSearchWorkspace, id: string) {
  const application = workspace.applications.find((item) => item.id === id);
  if (!application) throw new Error("Unknown application");
  return application;
}

function requireJob(workspace: JobSearchWorkspace, id: string): JobOpportunity {
  const job = workspace.opportunities.find((item) => item.id === id);
  if (!job) throw new Error("Unknown job opportunity");
  return job;
}
