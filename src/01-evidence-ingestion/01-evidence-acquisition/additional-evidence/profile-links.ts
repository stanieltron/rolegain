import { randomUUID } from "node:crypto";
import type {
  CandidateSource,
  JobSearchWorkspace,
} from "../../../contracts/job-search.js";
import { normalizeWebUrl } from "./read-source.js";
import {
  readSupplementalEvidence,
  type SupplementalEvidenceInput,
} from "./read-source.js";
import {
  evidenceUrlsMatch,
  markCandidateEvidenceForRebuild,
} from "./add-evidence.js";

export type ProfileEvidenceField = "linkedin" | "github" | "website";

export const PROFILE_EVIDENCE_FIELDS: readonly ProfileEvidenceField[] = [
  "linkedin",
  "github",
  "website",
];

const SOURCE_BY_FIELD: Record<
  ProfileEvidenceField,
  { kind: Exclude<CandidateSource["kind"], "cv">; name: string }
> = {
  linkedin: { kind: "webpage", name: "LinkedIn profile" },
  github: { kind: "github", name: "GitHub profile" },
  website: { kind: "portfolio", name: "Personal website" },
};

/** Stage changed profile links as pending supplemental evidence sources. */
export function stageProfileEvidenceSources(
  workspace: JobSearchWorkspace,
  fields: Iterable<ProfileEvidenceField>,
) {
  let changed = collapseEquivalentProfileEvidenceSources(workspace);
  let needsFetch = false;
  for (const field of fields) {
    const normalized = normalizeProfileEvidenceUrl(
      field,
      workspace.profile[field],
    );
    const managedIndex = workspace.sources.findIndex(
      (source) => source.profileField === field,
    );
    const managed =
      managedIndex >= 0 ? workspace.sources[managedIndex] : undefined;
    if (!normalized) {
      if (managedIndex >= 0) {
        workspace.sources.splice(managedIndex, 1);
        changed = true;
      }
      continue;
    }

    const url = normalized.href;
    const matchingManualSource = workspace.sources.find(
      (source) =>
        !source.profileField &&
        source.url &&
        evidenceUrlsMatch(source.url, url),
    );
    if (!managed && matchingManualSource) continue;
    if (
      managed &&
      evidenceUrlsMatch(managed.url, url) &&
      (managed.status === "processing" ||
        (managed.status === "ready" && Boolean(managed.content)) ||
        ((managed.status === "needs_review" ||
          managed.status === "analysis_failed") &&
          managed.analysisRequired === false))
    )
      continue;

    const metadata = SOURCE_BY_FIELD[field];
    if (managed) {
      Object.assign(managed, {
        kind: metadata.kind,
        name: metadata.name,
        url,
        content: "",
        contentHash: undefined,
        status: "processing",
        insights: [],
        error: undefined,
      });
    } else {
      workspace.sources.push({
        id: randomUUID(),
        kind: metadata.kind,
        name: metadata.name,
        url,
        profileField: field,
        content: "",
        status: "processing",
        insights: [],
        addedAt: new Date().toISOString(),
      });
    }
    changed = true;
    needsFetch = true;
  }
  if (needsFetch) {
    workspace.intelligence.status = "analyzing";
    workspace.intelligence.error = undefined;
  }
  return { changed, needsFetch };
}

/** Prefer an already-ingested manual source over an empty managed duplicate. */
export function collapseEquivalentProfileEvidenceSources(
  workspace: JobSearchWorkspace,
) {
  let changed = false;
  for (let index = workspace.sources.length - 1; index >= 0; index -= 1) {
    const managed = workspace.sources[index];
    if (!managed.profileField || !managed.url || managed.content?.trim()) continue;
    const equivalentReadySource = workspace.sources.some(
      (source, sourceIndex) =>
        sourceIndex !== index &&
        !source.profileField &&
        source.status === "ready" &&
        Boolean(source.content?.trim()) &&
        evidenceUrlsMatch(source.url, managed.url),
    );
    if (!equivalentReadySource) continue;
    workspace.sources.splice(index, 1);
    changed = true;
  }
  return changed;
}

export function isProfileEvidenceField(
  value: string,
): value is ProfileEvidenceField {
  return PROFILE_EVIDENCE_FIELDS.includes(value as ProfileEvidenceField);
}

export function normalizeProfileEvidenceUrl(
  field: ProfileEvidenceField,
  value: string,
) {
  const url = normalizeWebUrl(value);
  if (!url) return undefined;
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  const pathParts = url.pathname.split("/").filter(Boolean);
  if (field === "github" && (hostname !== "github.com" || pathParts.length < 1))
    return undefined;
  if (
    field === "linkedin" &&
    (hostname !== "linkedin.com" || pathParts.length < 1)
  )
    return undefined;
  return url;
}

export function profileSourceError(
  field: CandidateSource["profileField"],
  detail: string,
) {
  if (field === "linkedin" && /\b999\b/.test(detail))
    return "LinkedIn blocks automated reading. The link is saved as an optional profile field, but it was not added to candidate evidence.";
  return detail;
}

/** Read and merge every pending profile-owned supplemental source. */
export async function synchronizeProfileEvidenceSources(input: {
  workspace: JobSearchWorkspace;
  reloadWorkspace: () => Promise<JobSearchWorkspace>;
  analyzeWithLlm: boolean;
  signal: AbortSignal;
  reader?: typeof readSupplementalEvidence;
}) {
  const reader = input.reader ?? readSupplementalEvidence;
  const pending = input.workspace.sources
    .filter(
      (source) =>
        source.profileField &&
        source.status === "processing" &&
        Boolean(source.url),
    )
    .map((source) => ({
      id: source.id,
      field: source.profileField!,
      kind: source.kind as SupplementalEvidenceInput["kind"],
      name: source.name,
      url: source.url!,
    }));
  if (!pending.length)
    return { workspace: input.workspace, successes: 0, pendingAnalysis: false };

  const results = await Promise.all(
    pending.map(async (source) => {
      try {
        return {
          source,
          evidence: await reader(
            { kind: source.kind, name: source.name, url: source.url },
            input.signal,
          ),
        };
      } catch (error) {
        return {
          source,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  // Reload before applying network results so a concurrent profile edit wins.
  const current = await input.reloadWorkspace();
  let successes = 0;
  for (const result of results) {
    const source = current.sources.find(
      (item) =>
        item.id === result.source.id &&
        item.profileField === result.source.field &&
        item.url === result.source.url,
    );
    const currentUrl = normalizeProfileEvidenceUrl(
      result.source.field,
      current.profile[result.source.field],
    )?.href;
    if (!source || currentUrl !== result.source.url) continue;

    if ("evidence" in result && result.evidence) {
      const { relatedSources = [], ...primary } = result.evidence;
      Object.assign(source, primary, {
        url: result.source.url,
        profileField: result.source.field,
        status: input.analyzeWithLlm ? "processing" : "ready",
        analysisRequired: input.analyzeWithLlm,
        insights: [],
        error: undefined,
      });
      for (const related of relatedSources) {
        const { relatedSources: _nested, ...candidate } = related;
        const existing = current.sources.find(
          (item) =>
            (item.kind !== "cv" && item.contentHash === candidate.contentHash) ||
            (candidate.url && item.url === candidate.url),
        );
        if (existing) continue;
        current.sources.push({
          ...candidate,
          id: randomUUID(),
          status: input.analyzeWithLlm ? "processing" : "ready",
          analysisRequired: input.analyzeWithLlm,
          insights: [],
          addedAt: new Date().toISOString(),
        });
      }
      successes += 1;
    } else {
      source.status = source.profileField === "linkedin"
        ? "needs_review"
        : "analysis_failed";
      source.analysisRequired = false;
      source.error = profileSourceError(
        source.profileField,
        result.error || "This profile source could not be read",
      );
    }
  }

  if (successes > 0 && input.analyzeWithLlm)
    markCandidateEvidenceForRebuild(current);
  const pendingAnalysis = current.sources.some(
    (source) => source.analysisRequired,
  );
  current.intelligence.status = pendingAnalysis ? "analyzing" : "ready";
  current.intelligence.error = undefined;
  return { workspace: current, successes, pendingAnalysis };
}
