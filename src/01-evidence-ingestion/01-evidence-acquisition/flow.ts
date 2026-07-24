import type { JobSearchWorkspace } from "../../contracts/job-search.js";
import { addSupplementalEvidence } from "./additional-evidence/add-evidence.js";
import type { SupplementalEvidenceInput } from "./additional-evidence/read-source.js";
import { uploadCv } from "./cv/upload-cv.js";

export type EvidenceInput =
  | {
      kind: "cv";
      name: string;
      dataBase64?: string;
      content?: string;
      mimeType?: string;
    }
  | SupplementalEvidenceInput;

/** Stage 01: deterministically acquire either the CV or supplemental evidence. */
export async function acquireEvidence(input: {
  dataRoot: string;
  workspace: JobSearchWorkspace;
  source: EvidenceInput;
  analyzeWithLlm: boolean;
}) {
  if (input.source.kind === "cv") {
    await uploadCv(input.dataRoot, input.workspace, input.source);
    return { workspace: input.workspace, duplicate: false };
  }

  return addSupplementalEvidence({
    dataRoot: input.dataRoot,
    workspace: input.workspace,
    source: input.source,
    analyzeWithLlm: input.analyzeWithLlm,
  });
}
