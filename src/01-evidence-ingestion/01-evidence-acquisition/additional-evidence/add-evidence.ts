import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CandidateSource,
  JobSearchWorkspace,
} from "../../../contracts/job-search.js";
import { safeExtension } from "../cv/upload-cv.js";
import {
  readSupplementalEvidence,
  type SupplementalEvidence,
  type SupplementalEvidenceInput,
} from "./read-source.js";

/**
 * Add supplemental evidence without replacing the CV.
 *
 * Duplicate prevention is intentionally simple: two supplemental sources with
 * the same SHA-256 of normalized extracted text are the same evidence.
 */
export async function addSupplementalEvidence(input: {
  dataRoot: string;
  workspace: JobSearchWorkspace;
  source: SupplementalEvidenceInput;
  analyzeWithLlm: boolean;
  reader?: typeof readSupplementalEvidence;
}) {
  const { dataRoot, workspace, source: sourceInput, analyzeWithLlm } = input;

  // 1. Read the URL, text, or uploaded document into normalized text + hash.
  const acquired = await (input.reader ?? readSupplementalEvidence)(sourceInput);

  // 2. Add only content that is not already present. A URL whose content has
  // changed updates its existing source instead of creating a second source.
  let primarySource: CandidateSource | undefined;
  let changed = false;
  for (const evidence of flatten(acquired)) {
    const duplicateContent = workspace.sources.find(
      (candidate) =>
        candidate.kind !== "cv" &&
        candidate.contentHash === evidence.contentHash,
    );
    if (duplicateContent) {
      primarySource ??= duplicateContent;
      if (
        duplicateContent.status === "needs_review" ||
        duplicateContent.status === "analysis_failed"
      ) {
        duplicateContent.status = analyzeWithLlm ? "processing" : "ready";
        duplicateContent.analysisRequired = analyzeWithLlm;
        duplicateContent.error = undefined;
        changed = true;
      }
      continue;
    }

    const sameUrl = evidence.url
      ? workspace.sources.find((candidate) =>
          evidenceUrlsMatch(candidate.url, evidence.url),
        )
      : undefined;
    const values = candidateValues(evidence, analyzeWithLlm);
    if (sameUrl) {
      Object.assign(sameUrl, values);
      primarySource ??= sameUrl;
    } else {
      const added: CandidateSource = {
        id: randomUUID(),
        ...values,
        addedAt: new Date().toISOString(),
      };
      workspace.sources.push(added);
      primarySource ??= added;
    }
    changed = true;
  }

  if (!primarySource) throw new Error("The source produced no readable evidence");

  // 3. Keep the original uploaded file only when a new primary source was added.
  if (changed && sourceInput.dataBase64) {
    const directory = path.join(
      dataRoot,
      "job-search",
      "files",
      workspace.candidateId,
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${primarySource.id}${safeExtension(sourceInput.name)}`),
      decodeUploadedFile(sourceInput.dataBase64),
    );
    primarySource.originalFile = { name: sourceInput.name };
  }

  // 4. A true duplicate leaves the existing evidence and analysis untouched.
  if (changed) {
    markCandidateEvidenceForRebuild(workspace);
    workspace.profileSetupStep = 2;
  }

  return { workspace, source: primarySource, duplicate: !changed };
}

/**
 * Persist a URL without opening it. Commercial deployments use this in the
 * lightweight web process, then let the Chromium-equipped worker acquire it.
 */
export function stageSupplementalUrl(input: {
  workspace: JobSearchWorkspace;
  source: SupplementalEvidenceInput & { url: string };
}) {
  const { workspace, source: inputSource } = input;
  let source = workspace.sources.find((candidate) =>
    evidenceUrlsMatch(candidate.url, inputSource.url),
  );
  const pending: Omit<CandidateSource, "id" | "addedAt"> = {
    kind: inputSource.kind,
    name: inputSource.name,
    url: inputSource.url,
    content: "",
    contentHash: "",
    status: "processing",
    analysisRequired: true,
    insights: [],
    includeGitHubContributions:
      inputSource.includeGitHubContributions === true || undefined,
  };
  if (source) Object.assign(source, pending, { error: undefined, knowledgePath: undefined });
  else {
    source = {
      id: randomUUID(),
      ...pending,
      addedAt: new Date().toISOString(),
    };
    workspace.sources.push(source);
  }
  markCandidateEvidenceForRebuild(workspace);
  source.status = "processing";
  source.analysisRequired = true;
  workspace.profileSetupStep = 2;
  return { workspace, source, duplicate: false };
}

function flatten(source: SupplementalEvidence): SupplementalEvidence[] {
  const { relatedSources = [], ...primary } = source;
  return [primary, ...relatedSources.flatMap(flatten)];
}

function candidateValues(
  evidence: SupplementalEvidence,
  analyzeWithLlm: boolean,
): Omit<CandidateSource, "id" | "addedAt"> {
  return {
    kind: evidence.kind,
    name: evidence.name,
    url: evidence.url,
    content: evidence.content,
    contentHash: evidence.contentHash,
    status: analyzeWithLlm ? "processing" : "ready",
    analysisRequired: analyzeWithLlm,
    insights: [],
  };
}

export function markCandidateEvidenceForRebuild(
  workspace: JobSearchWorkspace,
) {
  workspace.discoveryNeedsRun = true;
  for (const source of workspace.sources) {
    source.analysisRequired =
      source.status !== "analysis_failed" &&
      source.status !== "needs_review" &&
      Boolean(source.content?.trim());
  }
  workspace.intelligence.status = "analyzing";
  workspace.intelligence.error = undefined;
  workspace.intelligence.progress = undefined;
  delete workspace.intelligence.evidenceRun;
}

export function evidenceUrlsMatch(left?: string, right?: string) {
  if (!left || !right) return false;
  try {
    const canonical = (value: string) => {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
      const pathname = url.pathname.replace(/\/+$/, "") || "/";
      return `${hostname}${url.port ? `:${url.port}` : ""}${pathname}${url.search}`;
    };
    return canonical(left) === canonical(right);
  } catch {
    return left === right;
  }
}

function decodeUploadedFile(value: string) {
  const normalized = value.includes(",")
    ? value.slice(value.indexOf(",") + 1)
    : value;
  return Buffer.from(normalized, "base64");
}
