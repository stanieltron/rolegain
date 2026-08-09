import type { JobSearchWorkspace } from "../../contracts/job-search.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import { productionModel } from "../../codex-runtime/call-manifest.js";
import type {
  ProfileFieldEvidenceDraft,
  SearchVocabularyDraft,
} from "../../contracts/evidence.js";
import {
  buildInput as buildSynthesisPrompt,
  command as SYNTHESIS_COMMAND,
  outputSchema as candidateSynthesisSchema,
  outputSchemaV2 as candidateSynthesisSchemaV2,
  rolePrompt as CANDIDATE_INTELLIGENCE_INSTRUCTIONS,
  type EvidenceSynthesisOutput,
  type EvidenceSynthesisOutputV2,
} from "./llm-calls/01-evidence-synthesis/index.js";
import type {
  CandidateAnalysisProgress,
  CandidateAnalysisResult,
  ChunkReadingResult,
} from "../types.js";

/** Stage 3: reduce all reader outputs into one candidate profile and role model. */
export async function synthesizeCandidateEvidence(input: {
  codex: CodexExecClient;
  cwd: string;
  workspace: JobSearchWorkspace;
  /** Explicit inspection/eval override. */
  model?: string;
  reading: ChunkReadingResult;
  version?: "v1" | "v2";
  message?: string;
  onProgress?: (progress: CandidateAnalysisProgress) => void | Promise<void>;
}): Promise<CandidateAnalysisResult> {
  const {
    codex,
    cwd,
    workspace,
    reading,
    message,
    onProgress,
    version = "v1",
  } = input;
  const model = input.model ?? productionModel(SYNTHESIS_COMMAND);

  // 1. Tell the product that all reader calls have joined.
  await onProgress?.({
    stage: "synthesizing",
    completed: reading.totalChunks,
    total: reading.chunkCoverage?.totalChunks ?? reading.totalChunks,
    ...(reading.chunkCoverage?.limitReached
      ? { limit: reading.chunkCoverage.limit, limitReached: true }
      : {}),
  });

  // 2. Run one isolated reducer call over reader-produced facts and signals.
  const thread = await codex.startThread({
    cwd,
    callId: "evidence.synthesis",
    role: SYNTHESIS_COMMAND.role,
    sandbox: SYNTHESIS_COMMAND.threadSandbox,
    model,
    approvalPolicy: SYNTHESIS_COMMAND.approvalPolicy,
    developerInstructions: CANDIDATE_INTELLIGENCE_INSTRUCTIONS,
  });
  const turn = await codex.runTurn({
    threadId: thread.id,
    prompt: buildSynthesisPrompt({
      workspace,
      sourceNotes: reading.sourceNotes,
      message,
      version,
    }),
    cwd,
    sandbox: SYNTHESIS_COMMAND.sandbox,
    outputSchema:
      version === "v2" ? candidateSynthesisSchemaV2 : candidateSynthesisSchema,
    model,
    approvalPolicy: SYNTHESIS_COMMAND.approvalPolicy,
    effort: SYNTHESIS_COMMAND.effort,
    timeoutMs: SYNTHESIS_COMMAND.timeoutMs,
  });

  // 3. Keep source insights/claims from the readers; synthesis owns only the
  // cross-source profile, unknowns, role families and search vocabulary.
  if (version === "v2") {
    const synthesis = JSON.parse(turn.finalText) as EvidenceSynthesisOutputV2;
    const profile = preferCvIdentity(
      synthesis.profile,
      workspace,
      reading,
    );
    return {
      ...synthesis,
      profile,
      chunkCoverage: reading.chunkCoverage,
      searchVocabulary: restoreDerivedSearchVocabulary(synthesis),
      profileEvidence: restoreSelectedProfileEvidence(
        profile,
        reading,
      ),
      threadId: thread.id,
      sourceInsights: reading.sourceInsights,
    };
  }
  const synthesis = JSON.parse(turn.finalText) as EvidenceSynthesisOutput;
  const profile = preferCvIdentity(synthesis.profile, workspace, reading);
  return {
    ...synthesis,
    profile,
    chunkCoverage: reading.chunkCoverage,
    profileEvidence: restoreSelectedProfileEvidence(
      profile,
      reading,
      synthesis.profileEvidence,
    ),
    threadId: thread.id,
    sourceInsights: reading.sourceInsights,
  };
}

function preferCvIdentity(
  proposed: JobSearchWorkspace["profile"],
  workspace: JobSearchWorkspace,
  reading: ChunkReadingResult,
) {
  const profile = {
    ...proposed,
    skills: [...proposed.skills],
    languages: [...proposed.languages],
  };
  const cvSourceIds = new Set(
    workspace.sources
      .filter((source) => source.kind === "cv")
      .map((source) => source.id),
  );
  const evidence = reading.sourceNotes.flatMap((source) =>
    source.chunks.flatMap((chunk) => chunk.profileEvidence),
  );
  for (const field of ["name", "email"] as const) {
    const current = workspace.profile[field].trim();
    const origin = workspace.profileFieldOrigins?.[field];
    if (current && origin !== "auth") continue;
    const fromCv = evidence.find(
      (item) => item.field === field && cvSourceIds.has(item.sourceId),
    )?.value.trim();
    if (fromCv) profile[field] = fromCv;
  }
  return profile;
}

function restoreDerivedSearchVocabulary(
  synthesis: EvidenceSynthesisOutputV2,
): SearchVocabularyDraft {
  const roles = synthesis.roleFamilies || [];
  return {
    titleAliases: uniqueStrings(
      roles.flatMap((role) => [role.canonicalTitle, ...role.titleAliases]),
    ).slice(0, 30),
    evidenceIntersections:
      synthesis.searchVocabulary?.evidenceIntersections || [],
    problemPhrases: uniqueStrings(
      roles.flatMap((role) => role.problemPhrases),
    ).slice(0, 30),
    toolsMethodsStandards:
      synthesis.searchVocabulary?.toolsMethodsStandards || [],
    adjacentDialects: synthesis.searchVocabulary?.adjacentDialects || [],
    seniorityOwnershipModifiers:
      synthesis.searchVocabulary?.seniorityOwnershipModifiers || [],
    geographyLanguageVariants:
      synthesis.searchVocabulary?.geographyLanguageVariants || [],
    negativeTerms: synthesis.searchVocabulary?.negativeTerms || [],
  };
}

function restoreSelectedProfileEvidence(
  profile: JobSearchWorkspace["profile"],
  reading: ChunkReadingResult,
  suppliedEvidence: ProfileFieldEvidenceDraft[] = [],
) {
  const readerEvidence = reading.sourceNotes.flatMap((source) =>
    source.chunks.flatMap((chunk) => chunk.profileEvidence),
  );
  const selectedReaderEvidence = readerEvidence.filter((evidence) => {
    const selected = profile[evidence.field];
    return Array.isArray(selected)
      ? selected.some((value) => sameValue(value, evidence.value))
      : sameValue(selected, evidence.value);
  });
  const seen = new Set<string>();
  return [...suppliedEvidence, ...selectedReaderEvidence].filter(
    (evidence: ProfileFieldEvidenceDraft) => {
      const key = [
        evidence.field,
        evidence.value.trim().toLowerCase(),
        evidence.sourceId,
        evidence.quote,
      ].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  );
}

function sameValue(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
