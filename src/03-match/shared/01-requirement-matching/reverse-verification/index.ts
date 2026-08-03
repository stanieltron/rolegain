import type { JobOpportunity } from "../../../../contracts/job-search.js";
import type { CodexExecClient } from "../../../../codex-runtime/client.js";
import {
  verifyAssessments,
  type AgentRequirementAssessment,
  type AssessmentVerification,
} from "../index.js";

export interface ReverseVerifyOneMatchInput {
  codex: CodexExecClient;
  cwd: string;
  model?: string;
  sourceLedger: unknown;
  opportunity: JobOpportunity;
  assessment: AgentRequirementAssessment;
}

/**
 * Independently reverse-verify one proposed match in a fresh model context.
 * This function performs no repair and is directly usable by tests, inspection
 * tools, and targeted re-verification workflows.
 */
export async function reverseVerifyOneMatch(
  input: ReverseVerifyOneMatchInput,
): Promise<AssessmentVerification> {
  const [verification] = await verifyAssessments(
    input.codex,
    input.cwd,
    input.model,
    input.sourceLedger,
    [input.opportunity],
    [input.assessment],
  );
  if (!verification)
    throw new Error(`Reverse verifier returned no result for ${input.opportunity.id}`);
  return verification;
}
