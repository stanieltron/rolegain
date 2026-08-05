import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import type { ProfileFieldEvidence } from "../../contracts/evidence.js";
import type { EvidenceIngestionVersion } from "../../config/runtime.js";
import { CodexCandidateAnalyzerV1 } from "../v1/index.js";
import { CodexCandidateAnalyzerV2 } from "../v2/index.js";
import { verifyAndPersistEvidence } from "../04-verification/index.js";
import { mockWorkspaceWithCv } from "../inspection/fixtures.js";
import { evidenceEvalCorpus } from "./corpus.js";
import type { EvidenceEvalCase } from "./corpus.js";
import { gradeEvidenceEval } from "./grader.js";

export async function runEvidenceEvals(input: {
  codex: CodexExecClient;
  projectRoot: string;
  trials?: number;
  version?: EvidenceIngestionVersion;
}) {
  const trials = Math.max(1, Math.min(5, input.trials || 3));
  const version = input.version ?? "v1";
  const results: unknown[] = [];
  for (const testCase of evidenceEvalCorpus) {
    for (let trial = 1; trial <= trials; trial += 1) {
      const workspace = evalWorkspace(testCase);
      const dataRoot = await mkdtemp(
        path.join(tmpdir(), `rolegain-eval-${testCase.id}-`),
      );
      try {
        const Analyzer = version === "v2"
          ? CodexCandidateAnalyzerV2
          : CodexCandidateAnalyzerV1;
        const analysis = await new Analyzer(
          input.codex,
          input.projectRoot,
        ).analyze(workspace);
        const evidenceRun = await verifyAndPersistEvidence({
          dataRoot,
          workspace,
          analysis,
          sourceIdsToAnalyze: new Set([workspace.sources[0].id]),
        });
        const profileEvidence = JSON.parse(
          await readFile(
            path.join(evidenceRun.directory, "profile-evidence.json"),
            "utf8",
          ),
        ) as ProfileFieldEvidence[];
        results.push({
          caseId: testCase.id,
          version,
          trial,
          grade: gradeEvidenceEval({ testCase, analysis, profileEvidence }),
          readiness: evidenceRun.manifest.readiness,
        });
      } catch (error) {
        results.push({
          caseId: testCase.id,
          version,
          trial,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return results;
}

function evalWorkspace(testCase: EvidenceEvalCase) {
  const { id, cvText } = testCase;
  const workspace = mockWorkspaceWithCv();
  workspace.id = `eval-${id}`;
  workspace.candidateId = `eval-${id}`;
  workspace.profile.name = "";
  workspace.profile.email = "";
  workspace.profile.location = "";
  workspace.profile.workplace = "";
  workspace.profile.employmentTypes = "";
  workspace.profile.startDate = "";
  workspace.finalCv = cvText;
  workspace.sources[0] = {
    ...workspace.sources[0],
    id: `cv-${id}`,
    name: `${id}.txt`,
    kind: testCase.sourceKind || "cv",
    url: testCase.sourceUrl || "",
    content: cvText,
  };
  return workspace;
}
