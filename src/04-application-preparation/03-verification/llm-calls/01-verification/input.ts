import type { buildApplicationContext } from "../../../01-context/index.js";
import type { ApplicationContentDraft } from "../../../types.js";

type ApplicationContext = Awaited<ReturnType<typeof buildApplicationContext>>;

export interface DeterministicApplicationFinding {
  applicationId: string;
  message: string;
}

export function buildInput(input: {
  contexts: ApplicationContext[];
  drafts: ApplicationContentDraft[];
  deterministicFindings: DeterministicApplicationFinding[];
}) {
  return `Independently verify every application draft.

Original application contexts:
${JSON.stringify(input.contexts, null, 2)}

Generated drafts:
${JSON.stringify(input.drafts, null, 2)}

Deterministic pre-check findings (these must be addressed):
${JSON.stringify(input.deterministicFindings, null, 2)}

Return one verification for every supplied applicationId.

Verdict rules:
- pass: all generated content is grounded and no candidate input is missing.
- needs_input: generated content is acceptable, but one or more required personal, authorization, location, compensation, demographic, or other candidate-owned facts remain honestly blank. This is a successful verification state, not a repair request.
- needs_repair: generated content itself is wrong, unsupported, mapped to the wrong field, omits a narrative answer that can be grounded from supplied evidence, or violates an employer option.

Check every material generated candidate claim against source evidence and ensure narrative answers address their exact fields. Treat non-empty currentValue entries whose currentValueSource is profile, cv, or user as confirmed candidate data; do not demand separate CV evidence for identity, contact, profile URLs, location, or other confirmed profile facts. Do not reject an honest blank merely because the missing fact can only be supplied by the candidate.`;
}

export const inputDescription =
  "Original contexts, generated drafts, and deterministic pre-check findings.";
