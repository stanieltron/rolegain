import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CandidateSource,
  JobSearchWorkspace,
} from "../../../contracts/job-search.js";
import { readUploadedDocument } from "../additional-evidence/read-source.js";

export class CvValidationError extends Error {
  readonly code = "CV_NOT_OPENABLE";

  constructor(detail: string, options?: { cause?: unknown }) {
    super(`CV could not be opened: ${detail}`, options);
    this.name = "CvValidationError";
  }
}

export interface ValidatedCvInput {
  name: string;
  bytes: Buffer;
  text: string;
}

/** Parse the complete upload before any current CV state or artifact is changed. */
export async function validateCvInput(input: {
  name: string;
  dataBase64?: string;
  content?: string;
}): Promise<ValidatedCvInput> {
  const name = input.name.trim() || "cv";
  try {
    const parsed = input.dataBase64
      ? await readUploadedDocument(input.dataBase64, name)
      : readPlainTextCv(input.content, name);
    return { name, ...parsed };
  } catch (error) {
    if (error instanceof CvValidationError) throw error;
    throw new CvValidationError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

/**
 * Stage 1: accept one CV and make it the candidate's only active CV.
 *
 * This stage is completely deterministic. It finishes before HTTP 202 is sent;
 * the queued reader/synthesis flow starts afterward.
 */
export async function uploadCv(
  dataRoot: string,
  workspace: JobSearchWorkspace,
  input: { name: string; dataBase64?: string; content?: string },
): Promise<JobSearchWorkspace> {
  // 1. Parse and validate the complete new CV before touching the usable one.
  const { name, bytes, text } = await validateCvInput(input);

  // 2. Store the new original under the new source id.
  const sourceId = randomUUID();
  const filesDirectory = path.join(
    dataRoot,
    "job-search",
    "files",
    workspace.candidateId,
  );
  await mkdir(filesDirectory, { recursive: true });
  await writeFile(
    path.join(filesDirectory, `${sourceId}${safeExtension(name)}`),
    bytes,
  );

  // 3. Install one deliberately small active CV record in memory. The service
  // persists this workspace atomically before cleaning up replaced artifacts.
  const cv: CandidateSource = {
    id: sourceId,
    kind: "cv",
    name,
    content: text,
    originalFile: { name },
    status: "processing",
    analysisRequired: true,
    insights: [],
    addedAt: new Date().toISOString(),
  };
  workspace.sources = [
    ...workspace.sources.filter((source) => source.kind !== "cv"),
    cv,
  ];
  workspace.finalCv = text;
  fillContactDetails(workspace, text);

  // 4. Invalidate the candidate-wide evidence model. The background stages
  // rebuild it from the new CV and every other active evidence source.
  workspace.discoveryNeedsRun = true;
  workspace.profileSetupStep = 1;
  for (const source of workspace.sources) {
    source.analysisRequired =
      source.status !== "analysis_failed" &&
      source.status !== "needs_review" &&
      Boolean(source.content?.trim());
  }
  workspace.intelligence = { status: "analyzing" };

  return workspace;
}

function readPlainTextCv(content: string | undefined, name: string) {
  const text = content?.replace(/\u0000/g, "").trim() || "";
  if (!text) throw new Error(`${name} contains no readable text`);
  return { bytes: Buffer.from(text, "utf8"), text };
}

/** Remove replaced CV files only after the replacement workspace is durable. */
export async function cleanupReplacedCvArtifacts(
  dataRoot: string,
  candidateId: string,
  sources: CandidateSource[],
) {
  const removals = sources.flatMap((source) => {
    const files: Promise<unknown>[] = [];
    if (source.originalFile)
      files.push(
        rm(
          path.join(
            dataRoot,
            "job-search",
            "files",
            candidateId,
            `${source.id}${safeExtension(source.originalFile.name)}`,
          ),
          { force: true },
        ),
      );
    if (source.knowledgePath) {
      const knowledgeFile = path.resolve(dataRoot, source.knowledgePath);
      const allowedRoot = `${path.resolve(dataRoot, "job-search")}${path.sep}`;
      if (knowledgeFile.startsWith(allowedRoot))
        files.push(rm(knowledgeFile, { force: true }));
    }
    return files;
  });
  removals.push(
    rm(
      path.join(
        dataRoot,
        "job-search",
        "runs",
        candidateId,
        "evidence-runs",
      ),
      { recursive: true, force: true },
    ),
  );
  await Promise.all(removals);
}

function fillContactDetails(workspace: JobSearchWorkspace, content: string) {
  const email = content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const phone = content
    .match(/(?:\+?\d[\d ().-]{7,}\d)/g)
    ?.map((value) => value.trim())
    .find(isPlausiblePhone);

  if (!workspace.profile.email && email) workspace.profile.email = email;
  if (!workspace.profile.phone && phone) workspace.profile.phone = phone;
}

function isPlausiblePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  return (
    digits.length >= 9 &&
    digits.length <= 15 &&
    !/^\s*\d{4}\s*[-\u2013]\s*\d{4}\s*$/.test(value)
  );
}

export function safeExtension(name: string) {
  const extension = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".bin";
}
