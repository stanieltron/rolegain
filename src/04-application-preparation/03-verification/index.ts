import type { CodexExecClient } from "../../codex-runtime/client.js";
import type { buildApplicationContext } from "../01-context/index.js";
import type {
  ApplicationContentDraft,
  ApplicationDraftVerification,
} from "../types.js";
import {
  buildInput,
  command,
  outputSchema,
  rolePrompt,
  type ApplicationVerificationOutput,
  type DeterministicApplicationFinding,
} from "./llm-calls/01-verification/index.js";

type ApplicationContext = Awaited<ReturnType<typeof buildApplicationContext>>;

/** Stage 3: independently verify grounding and deterministic form rules. */
export async function verifyApplicationDrafts(input: {
  codex: CodexExecClient;
  cwd: string;
  model?: string;
  contexts: ApplicationContext[];
  drafts: ApplicationContentDraft[];
}): Promise<ApplicationDraftVerification[]> {
  const deterministic = deterministicDraftFindings(
    input.contexts,
    input.drafts,
  );
  const thread = await input.codex.startThread({
    cwd: input.cwd,
    callId: "application.verify",
    role: command.role,
    sandbox: "read-only",
    model: input.model,
    approvalPolicy: command.approvalPolicy,
    developerInstructions: rolePrompt,
  });
  const result = await input.codex.runTurn({
    threadId: thread.id,
    cwd: input.cwd,
    sandbox: command.sandbox,
    outputSchema,
    model: input.model,
    effort: command.effort,
    timeoutMs: command.timeoutMs,
    prompt: buildInput({
      contexts: input.contexts,
      drafts: input.drafts,
      deterministicFindings: deterministic,
    }),
  });
  const parsed = JSON.parse(result.finalText) as ApplicationVerificationOutput;
  const byId = new Map(
    parsed.verifications.map((item) => [item.applicationId, item]),
  );
  return input.contexts.map((context) => {
    const modelResult = byId.get(context.applicationId);
    const codeFindings = deterministic.filter(
      (item) => item.applicationId === context.applicationId,
    );
    if (!modelResult)
      return {
        applicationId: context.applicationId,
        verdict: "needs_repair" as const,
        findings: ["Verifier omitted this application"],
        repairInstructions: ["Return this applicationId exactly once"],
      };
    if (!codeFindings.length) return modelResult;
    return {
      ...modelResult,
      verdict: "needs_repair" as const,
      findings: [
        ...modelResult.findings,
        ...codeFindings.map((item) => item.message),
      ],
      repairInstructions: [
        ...modelResult.repairInstructions,
        ...codeFindings.map((item) => item.message),
      ],
    };
  });
}

function deterministicDraftFindings(
  contexts: ApplicationContext[],
  drafts: ApplicationContentDraft[],
) {
  const findings: DeterministicApplicationFinding[] = [];
  const byId = new Map<string, ApplicationContentDraft[]>();
  for (const draft of drafts) {
    const values = byId.get(draft.applicationId) || [];
    values.push(draft);
    byId.set(draft.applicationId, values);
  }
  for (const context of contexts) {
    const matches = byId.get(context.applicationId) || [];
    if (matches.length !== 1) {
      findings.push({
        applicationId: context.applicationId,
        message: `Expected exactly one draft for this application, received ${matches.length}`,
      });
      continue;
    }
    const draft = matches[0];
    if (context.requiresCoverLetter && !draft.coverLetter.trim())
      findings.push({
        applicationId: context.applicationId,
        message: "The employer requires a cover letter but the draft is empty",
      });
    if (!context.requiresCoverLetter && draft.coverLetter.trim())
      findings.push({
        applicationId: context.applicationId,
        message:
          "The employer does not request a cover letter, so coverLetter must be empty",
      });
    const fields = new Map(
      context.employerFields.map((field) => [field.fieldId, field]),
    );
    const seen = new Set<string>();
    for (const answer of draft.answers || []) {
      const field = fields.get(answer.fieldId);
      if (!field) {
        findings.push({
          applicationId: context.applicationId,
          message: `Answer references unknown fieldId ${answer.fieldId}`,
        });
        continue;
      }
      if (seen.has(answer.fieldId))
        findings.push({
          applicationId: context.applicationId,
          message: `Field ${answer.fieldId} was answered more than once`,
        });
      seen.add(answer.fieldId);
      if (answer.value.trim() && !answer.evidenceBasis.trim())
        findings.push({
          applicationId: context.applicationId,
          message: `Answer for ${field.label} has no evidence basis`,
        });
      if (
        answer.value.trim() &&
        field.options.length &&
        !field.options.includes(answer.value.trim())
      )
        findings.push({
          applicationId: context.applicationId,
          message: `Answer for ${field.label} is not one of the employer's options`,
        });
    }
  }
  return findings;
}
