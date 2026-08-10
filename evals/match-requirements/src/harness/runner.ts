import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CodexExecClient,
  type CodexRunObservation,
} from "../../../../src/codex-runtime/client.js";
import type { LlmConfigurationSet } from "../../../../src/codex-runtime/llm-call-config.js";
import type { MatchVersion } from "../../../../src/config/runtime.js";
import { matchOneOpportunity } from "../../../../src/03-match/shared/01-requirement-matching/match-one/index.js";
import {
  escalateUnresolvedRequirements,
  verifyAssessments,
  verifyAndRepairAssessments,
  type AgentRequirementAssessment,
} from "../../../../src/03-match/shared/01-requirement-matching/index.js";
import {
  buildInput as buildRequirementMatchingInput,
  command as REQUIREMENT_MATCHING_COMMAND,
  outputSchema as opportunityAssessmentsSchema,
  rolePrompt as REQUIREMENT_MATCHING_ROLE_PROMPT,
  type RequirementAssessmentOutput,
} from "../../../../src/03-match/shared/01-requirement-matching/llm-calls/01-requirement-matching/index.js";
import {
  leanRequirementOutputSchema,
  leanRequirementRolePrompt,
} from "../../../../src/03-match/v2/contract.js";
import {
  loadPhase2EvidenceContext,
  retrieveCanonicalClaimLedger,
  retrieveKnowledgeRoutes,
} from "../../../../src/search-match-shared/evidence-context.js";
import { matchRequirementsCorpus } from "../dataset/corpus.js";
import { prepareMatchEvalCase } from "../dataset/fixtures.js";
import type { PreparedMatchEvalCase } from "../dataset/types.js";
import { gradeMatchRequirements } from "../graders/requirement-matrix.js";
import {
  buildAssessmentChallenge,
  buildGoldAssessment,
} from "../graders/assessment-challenges.js";
import { gradeVerifier, type VerifierEvalGrade } from "../graders/verifier.js";
import { evaluateReleaseGates } from "./release-gate.js";
import { renderMatchEvalReport } from "./report.js";
import { snapshotMatchConfigurationSources } from "./configuration-snapshot.js";
import { summarizeMatchEvalResults } from "./summary.js";
import {
  MATCH_REQUIREMENTS_CORPUS_VERSION,
  type MatchEvalGrade,
  type MatchRequirementsEvalCase,
} from "../dataset/types.js";

export type MatchEvalSuite =
  | "match.requirements.component"
  | "match.tier2.component"
  | "match.verification.component"
  | "match.repair.component"
  | "match.full-flow";

const DEFAULT_MATCH_EVAL_SUITES: MatchEvalSuite[] = [
  "match.requirements.component",
  "match.tier2.component",
  "match.verification.component",
  "match.repair.component",
  "match.full-flow",
];

export interface MatchEvalOptions {
  cwd: string;
  models: string[];
  configuration?: LlmConfigurationSet;
  trials: number;
  concurrency: number;
  caseIds?: string[];
  splits?: Array<"development" | "test">;
  suites?: MatchEvalSuite[];
  includeRepairChallenges?: boolean;
  outputRoot?: string;
  version?: MatchVersion;
}

export interface MatchEvalTrialResult {
  configurationId: string;
  version: MatchVersion;
  model: string;
  suite: MatchEvalSuite;
  caseId: string;
  trial: number;
  passed: boolean;
  wallMs: number;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  repairInvoked: boolean;
  tier2Invoked: boolean;
  pipelineAccepted: boolean;
  grade: MatchEvalGrade;
  componentGrade?: MatchEvalGrade;
  verifierGrade?: VerifierEvalGrade;
  error?: string;
  errorType?: string;
  artifactDirectory: string;
}

interface EvalJob {
  configurationId: string;
  model: string;
  suite: MatchEvalSuite;
  testCase: MatchRequirementsEvalCase;
  trial: number;
}

interface CallTrace extends CodexRunObservation {
  parsedOutput?: unknown;
  prompt?: string;
  schema?: unknown;
  gateway?: unknown;
}

const observations = new AsyncLocalStorage<CodexRunObservation[]>();

export async function runMatchRequirementsEval(options: MatchEvalOptions) {
  validateOptions(options);
  const version = options.version ?? "v1";
  const selectedCases = selectCases(options.caseIds, options.splits);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputRoot = path.resolve(
    options.outputRoot ||
      path.join(
        options.cwd,
        ".agent-runtime",
        "match-requirements",
        "runs",
        version,
        timestamp,
      ),
  );
  await mkdir(outputRoot, { recursive: true });
  await snapshotMatchConfigurationSources(
    options.cwd,
    outputRoot,
    options.configuration,
  );

  const codex = new CodexExecClient(options.cwd, options.configuration);
  const runtime = await codex.start();
  if (!runtime.authenticated)
    throw new Error("The shared Codex connection is not authenticated");
  codex.onRunCompleted = (observation) => {
    observations.getStore()?.push(observation);
  };

  const jobs: EvalJob[] = [];
  const configurationId = options.configuration?.id || "production-default";
  const suites = new Set<MatchEvalSuite>(options.suites || (
    version === "v2"
      ? ["match.requirements.component", "match.full-flow"]
      : DEFAULT_MATCH_EVAL_SUITES
  ));
  for (const model of options.models) {
    for (let trial = 1; trial <= options.trials; trial += 1) {
      for (const testCase of selectedCases) {
        if (suites.has("match.requirements.component"))
          jobs.push({
            configurationId,
            model,
            suite: "match.requirements.component",
            testCase,
            trial,
          });
        if (suites.has("match.tier2.component"))
          jobs.push({
            configurationId,
            model,
            suite: "match.tier2.component",
            testCase,
            trial,
          });
        if (suites.has("match.full-flow"))
          jobs.push({
            configurationId,
            model,
            suite: "match.full-flow",
            testCase,
            trial,
          });
        if (
          suites.has("match.verification.component") &&
          testCase.verifierChallenge
        )
          jobs.push({
            configurationId,
            model,
            suite: "match.verification.component",
            testCase,
            trial,
          });
        if (
          suites.has("match.repair.component") &&
          options.includeRepairChallenges !== false &&
          testCase.repairChallenge
        )
          jobs.push({
            configurationId,
            model,
            suite: "match.repair.component",
            testCase,
            trial,
          });
      }
    }
  }

  await writeJson(path.join(outputRoot, "run-config.json"), {
    corpusVersion: MATCH_REQUIREMENTS_CORPUS_VERSION,
    configuration: options.configuration || {
      id: "production-default",
      overrides: {},
    },
    startedAt: new Date().toISOString(),
    models: options.models,
    trials: options.trials,
    concurrency: options.concurrency,
    cases: selectedCases.map((item) => item.id),
    suites: [...new Set(jobs.map((item) => item.suite))],
    runtime,
    connection: "shared CodexExecClient / CODEX_HOME",
  });

  let completed = 0;
  const results = await mapConcurrent(jobs, options.concurrency, async (job) => {
    const result = await runJob(codex, options.cwd, outputRoot, job, version);
    completed += 1;
    process.stdout.write(
      `[${completed}/${jobs.length}] ${job.model} ${job.suite} ${job.testCase.id} ` +
        `${result.passed ? "PASS" : "FAIL"} ${result.wallMs}ms ${result.totalTokens} tokens\n`,
    );
    return result;
  });
  await codex.close();

  const summary = summarizeMatchEvalResults(results, selectedCases, {
    requestedTrials: options.trials,
    suites: [...new Set(results.map((item) => item.suite))],
    runtimeVersion: runtime.version,
    runtimeCompatible: runtime.compatible,
    pipelineVersion: version,
  });
  const releaseGate = evaluateReleaseGates(summary);
  await writeJson(path.join(outputRoot, "summary.json"), summary);
  await writeJson(path.join(outputRoot, "release-gate.json"), releaseGate);
  await writeFile(
    path.join(outputRoot, "trials.jsonl"),
    `${results.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outputRoot, "report.md"),
    renderMatchEvalReport(summary, results, releaseGate),
    "utf8",
  );
  return { outputRoot, runtime, results, summary, releaseGate };
}

async function runJob(
  codex: CodexExecClient,
  cwd: string,
  outputRoot: string,
  job: EvalJob,
  version: MatchVersion,
): Promise<MatchEvalTrialResult> {
  const slug = safeName(job.model);
  const artifactDirectory = path.join(
    outputRoot,
    slug,
    job.suite,
    `${job.testCase.id}-trial-${job.trial}`,
  );
  const dataRoot = path.join(artifactDirectory, "fixture-data");
  await mkdir(artifactDirectory, { recursive: true });
  const calls: CodexRunObservation[] = [];
  const startedAt = Date.now();
  let grade = emptyGrade(job.testCase);
  let error: string | undefined;
  let resultPayload: unknown;
  let pipelineAccepted = true;
  let verifierGrade: VerifierEvalGrade | undefined;

  await observations.run(calls, async () => {
    try {
      const prepared = await prepareMatchEvalCase(job.testCase, dataRoot);
      await writeJson(path.join(artifactDirectory, "input.json"), {
        workspace: prepared.workspace,
        opportunity: prepared.opportunity,
        canonicalLedger: prepared.sourceLedger,
        knowledgeRoutesByJob: prepared.knowledgeRoutesByJob,
      });
      await writeJson(path.join(artifactDirectory, "gold.json"), {
        corpusVersion: MATCH_REQUIREMENTS_CORPUS_VERSION,
        expected: job.testCase.expected,
        claimIdByKey: prepared.claimIdByKey,
      });

      if (job.suite === "match.requirements.component") {
        const assessment = await runMatchRequirementsComponent({
          codex,
          cwd,
          dataRoot,
          prepared,
          model: job.model,
          version,
        });
        grade = gradeAgentAssessment(
          job.testCase,
          assessment,
          prepared.claimIdByKey,
        );
        resultPayload = assessment;
      } else if (job.suite === "match.tier2.component") {
        const phase2Evidence = await loadPhase2EvidenceContext(
          dataRoot,
          prepared.workspace,
        );
        if (!phase2Evidence)
          throw new Error(`${job.testCase.id}: canonical evidence context is missing`);
        const seed = buildTier2SeedAssessment(buildGoldAssessment(prepared));
        const tier2 = await escalateUnresolvedRequirements(
          codex,
          cwd,
          job.model,
          [prepared.opportunity],
          [seed],
          phase2Evidence,
        );
        const assessment = tier2.assessments.find(
          (item) => item.jobId === prepared.opportunity.id,
        );
        grade = gradeAgentAssessment(
          job.testCase,
          assessment,
          prepared.claimIdByKey,
        );
        pipelineAccepted = Boolean(assessment);
        resultPayload = { seed, tier2 };
      } else if (job.suite === "match.full-flow") {
        const result = await matchOneOpportunity({
          codex,
          cwd,
          dataRoot,
          workspace: prepared.workspace,
          opportunity: prepared.opportunity,
          model: job.model,
          version,
        });
        const opportunity = result.opportunities.find(
          (item) => item.id === prepared.opportunity.id,
        );
        pipelineAccepted = Boolean(opportunity) && result.failures.length === 0;
        grade = gradeMatchRequirements({
          testCase: job.testCase,
          rows: opportunity?.requirementMatches || [],
          claimIdByKey: prepared.claimIdByKey,
        });
        resultPayload = result;
      } else if (job.suite === "match.verification.component") {
        const challenge = buildAssessmentChallenge(
          prepared,
          job.testCase.verifierChallenge!,
        );
        await writeJson(path.join(artifactDirectory, "challenge.json"), challenge);
        const reviews = await verifyAssessments(
          codex,
          cwd,
          job.model,
          prepared.sourceLedger,
          [prepared.opportunity],
          [challenge.assessment],
        );
        const review = reviews.find((item) => item.jobId === prepared.opportunity.id);
        verifierGrade = gradeVerifier(challenge, review);
        pipelineAccepted = Boolean(review);
        grade = gradeAgentAssessment(
          job.testCase,
          challenge.assessment,
          prepared.claimIdByKey,
        );
        resultPayload = { challenge, reviews };
      } else {
        const challenge = buildAssessmentChallenge(
          prepared,
          job.testCase.repairChallenge!,
        );
        await writeJson(path.join(artifactDirectory, "challenge.json"), challenge);
        const repaired = await verifyAndRepairAssessments(
          codex,
          cwd,
          job.model,
          prepared.sourceLedger,
          [prepared.opportunity],
          [challenge.assessment],
        );
        const assessment = repaired.assessments.find(
          (item) => item.jobId === prepared.opportunity.id,
        ) || repairedAssessmentFromCalls(calls, prepared.opportunity.id);
        pipelineAccepted = repaired.rejected.length === 0 && Boolean(assessment);
        grade = gradeAgentAssessment(
          job.testCase,
          assessment,
          prepared.claimIdByKey,
        );
        resultPayload = repaired;
      }
    } catch (caught) {
      pipelineAccepted = false;
      error = caught instanceof Error ? caught.stack || caught.message : String(caught);
    }
  });

  const callTraces = await Promise.all(calls.map(readCallTrace));
  const componentGrade =
    job.suite === "match.requirements.component"
      ? grade
      : job.suite === "match.full-flow"
      ? gradeAgentAssessment(
          job.testCase,
          assessmentFromCalls(calls, "match.requirements", job.testCase.id),
          await claimMapFromGold(artifactDirectory),
        )
      : undefined;
  await writeJson(path.join(artifactDirectory, "calls.json"), callTraces);
  await writeJson(path.join(artifactDirectory, "result.json"), resultPayload || null);
  await writeJson(path.join(artifactDirectory, "grade.json"), grade);
  if (error) await writeFile(path.join(artifactDirectory, "error.txt"), error, "utf8");

  const usage = sumUsage(calls);
  const passed =
    !error &&
    (job.suite === "match.verification.component"
      ? Boolean(verifierGrade?.passed)
      : pipelineAccepted && grade.passed);
  const result: MatchEvalTrialResult = {
    configurationId: job.configurationId,
    version,
    model: calls[0]?.model || job.model,
    suite: job.suite,
    caseId: job.testCase.id,
    trial: job.trial,
    passed,
    wallMs: Date.now() - startedAt,
    calls: calls.length,
    ...usage,
    repairInvoked: calls.some((item) => item.callId === "match.repair"),
    tier2Invoked: calls.some((item) => item.callId === "match.tier2-evidence"),
    pipelineAccepted,
    grade,
    componentGrade,
    verifierGrade,
    error,
    errorType: classifyFailure(
      error,
      pipelineAccepted,
      grade,
      job.suite,
      verifierGrade,
    ),
    artifactDirectory,
  };
  await writeJson(path.join(artifactDirectory, "trial.json"), result);
  return result;
}

async function runMatchRequirementsComponent(input: {
  codex: CodexExecClient;
  cwd: string;
  dataRoot: string;
  prepared: PreparedMatchEvalCase;
  model: string;
  version: MatchVersion;
}) {
  const phase2Evidence = await loadPhase2EvidenceContext(
    input.dataRoot,
    input.prepared.workspace,
  );
  if (!phase2Evidence)
    throw new Error(
      `${input.prepared.testCase.id}: canonical evidence context is missing`,
    );
  const evidenceByJob = retrieveCanonicalClaimLedger(phase2Evidence, [
    input.prepared.opportunity,
  ]);
  const knowledgeRoutesByJob = retrieveKnowledgeRoutes(phase2Evidence, [
    input.prepared.opportunity,
  ]);
  const thread = await input.codex.startThread({
    cwd: input.cwd,
    callId: "match.requirements",
    role: REQUIREMENT_MATCHING_COMMAND.role,
    sandbox: "read-only",
    model: input.model,
    approvalPolicy: REQUIREMENT_MATCHING_COMMAND.approvalPolicy,
    developerInstructions: input.version === "v2"
      ? leanRequirementRolePrompt
      : REQUIREMENT_MATCHING_ROLE_PROMPT,
  });
  const result = await input.codex.runTurn({
    threadId: thread.id,
    prompt: buildRequirementMatchingInput({
      assessmentEvidence: {
        evidenceRunId: phase2Evidence.evidenceRunId,
        evidenceByJob,
        knowledgeRoutesByJob,
        materialUnknowns: phase2Evidence.unknowns.filter(
          (unknown) => unknown.materiality !== "low",
        ),
        contradictions: phase2Evidence.contradictions,
        prohibitedInferences: phase2Evidence.prohibitedInferences,
      },
      opportunities: [input.prepared.opportunity],
    }),
    cwd: input.cwd,
    sandbox: REQUIREMENT_MATCHING_COMMAND.sandbox,
    outputSchema: input.version === "v2"
      ? leanRequirementOutputSchema
      : opportunityAssessmentsSchema,
    model: input.model,
    approvalPolicy: REQUIREMENT_MATCHING_COMMAND.approvalPolicy,
    effort: input.version === "v2"
      ? "low"
      : REQUIREMENT_MATCHING_COMMAND.effort,
    timeoutMs: REQUIREMENT_MATCHING_COMMAND.timeoutMs,
  });
  const assessment = JSON.parse(
    result.finalText,
  ) as RequirementAssessmentOutput;
  if (assessment.jobId !== input.prepared.opportunity.id)
    throw new Error(
      `match.requirements returned jobId ${assessment.jobId}; expected ${input.prepared.opportunity.id}`,
    );
  return assessment;
}

function buildTier2SeedAssessment(
  assessment: AgentRequirementAssessment,
): AgentRequirementAssessment {
  return {
    ...assessment,
    requirements: assessment.requirements.map((requirement) => ({
      ...requirement,
      status: "missing",
      matchClass: "unsupported",
      confidence: Math.min(requirement.confidence ?? 0.5, 0.5),
      gapClass: "evidence_quality",
      gapSeverity: "blocking",
      explanation:
        "No supporting evidence was found by the first-pass requirement matcher.",
      evidence: [],
    })),
  };
}

function assessmentFromCalls(
  calls: CodexRunObservation[],
  callId: string,
  caseId: string,
): AgentRequirementAssessment | undefined {
  const jobId = `job-${caseId}`;
  for (const call of calls) {
    if (call.callId !== callId || !call.finalText) continue;
    try {
      const assessment = JSON.parse(
        call.finalText,
      ) as AgentRequirementAssessment;
      if (assessment.jobId !== jobId) continue;
      if (assessment) return assessment;
    } catch {
      // Malformed output is represented by an empty component grade and call error.
    }
  }
  return undefined;
}

async function claimMapFromGold(artifactDirectory: string) {
  const gold = await readOptionalJson(path.join(artifactDirectory, "gold.json")) as
    | { claimIdByKey?: Record<string, string> }
    | undefined;
  return gold?.claimIdByKey || {};
}

function repairedAssessmentFromCalls(
  calls: CodexRunObservation[],
  jobId: string,
): AgentRequirementAssessment | undefined {
  for (const call of [...calls].reverse()) {
    if (call.callId !== "match.repair" || !call.finalText) continue;
    try {
      const assessment = JSON.parse(
        call.finalText,
      ) as AgentRequirementAssessment;
      if (assessment.jobId !== jobId) continue;
      if (assessment) return assessment;
    } catch {
      // The run trace retains malformed output for inspection.
    }
  }
  return undefined;
}

function gradeAgentAssessment(
  testCase: MatchRequirementsEvalCase,
  assessment: AgentRequirementAssessment | undefined,
  claimIdByKey: Record<string, string>,
) {
  return gradeMatchRequirements({
    testCase,
    rows: assessment?.requirements || [],
    claimIdByKey,
  });
}

async function readCallTrace(observation: CodexRunObservation): Promise<CallTrace> {
  const trace: CallTrace = { ...observation };
  const [prompt, schema, gateway] = await Promise.all([
    readOptional(path.join(observation.runDirectory, "prompt.txt")),
    readOptionalJson(path.join(observation.runDirectory, "schema.json")),
    readOptionalJson(path.join(observation.runDirectory, "gateway.json")),
  ]);
  trace.prompt = prompt;
  trace.schema = schema;
  trace.gateway = gateway;
  if (observation.finalText) {
    try {
      trace.parsedOutput = JSON.parse(observation.finalText);
    } catch {
      trace.parsedOutput = observation.finalText;
    }
  }
  return trace;
}

function sumUsage(calls: CodexRunObservation[]) {
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  for (const call of calls) {
    inputTokens += usageNumber(call.usage, "input_tokens", "inputTokens");
    cachedInputTokens += usageNumber(
      call.usage,
      "cached_input_tokens",
      "cachedInputTokens",
    );
    outputTokens += usageNumber(call.usage, "output_tokens", "outputTokens");
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function usageNumber(usage: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function classifyFailure(
  error: string | undefined,
  pipelineAccepted: boolean,
  grade: MatchEvalGrade,
  suite: MatchEvalSuite,
  verifierGrade?: VerifierEvalGrade,
) {
  if (error) {
    if (/DUPLICATE_IDENTITY/i.test(error)) return "duplicate_identity";
    if (/ResultGatewayError|result gateway/i.test(error)) return "result_gateway";
    if (/timed out/i.test(error)) return "timeout";
    if (/authenticated|login/i.test(error)) return "authentication";
    return "runtime_error";
  }
  if (!pipelineAccepted) return "pipeline_rejected";
  if (suite === "match.verification.component" && !verifierGrade?.passed) {
    if (verifierGrade?.expectedVerdict === "pass") return "verifier_false_positive";
    if (verifierGrade?.verdictPassed) return "verifier_untargeted_finding";
    return "verifier_false_negative";
  }
  if (grade.criticalFailures.length) return "critical_semantic_failure";
  if (!grade.passed) return "semantic_failure";
  return "none";
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
) {
  const output = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        output[index] = await operation(values[index]);
      }
    }),
  );
  return output;
}

function selectCases(
  caseIds?: string[],
  splits?: Array<"development" | "test">,
) {
  if (!caseIds?.length) {
    if (!splits?.length) return matchRequirementsCorpus;
    return matchRequirementsCorpus.filter((item) => splits.includes(item.split));
  }
  const wanted = new Set(caseIds);
  const selected = matchRequirementsCorpus.filter((item) => wanted.has(item.id));
  const missing = caseIds.filter((id) => !selected.some((item) => item.id === id));
  if (missing.length) throw new Error(`Unknown eval case(s): ${missing.join(", ")}`);
  return splits?.length
    ? selected.filter((item) => splits.includes(item.split))
    : selected;
}

function validateOptions(options: MatchEvalOptions) {
  if (!options.models.length) throw new Error("At least one model is required");
  if (!Number.isInteger(options.trials) || options.trials < 1)
    throw new Error("trials must be a positive integer");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1)
    throw new Error("concurrency must be a positive integer");
  if (options.version !== undefined && options.version !== "v1" && options.version !== "v2")
    throw new Error(`Unknown matching version: ${String(options.version)}`);
  const allowedSuites = new Set<MatchEvalSuite>([
    ...DEFAULT_MATCH_EVAL_SUITES,
  ]);
  const invalidSuites = (options.suites || []).filter(
    (suite) => !allowedSuites.has(suite),
  );
  if (invalidSuites.length)
    throw new Error(`Unknown eval suite(s): ${invalidSuites.join(", ")}`);
  const invalidSplits = (options.splits || []).filter(
    (split) => split !== "development" && split !== "test",
  );
  if (invalidSplits.length)
    throw new Error(`Unknown eval split(s): ${invalidSplits.join(", ")}`);
}

function emptyGrade(testCase: MatchRequirementsEvalCase): MatchEvalGrade {
  return gradeMatchRequirements({ testCase, rows: [], claimIdByKey: {} });
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readOptional(file: string) {
  return readFile(file, "utf8").catch(() => undefined);
}

async function readOptionalJson(file: string) {
  const value = await readOptional(file);
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}
