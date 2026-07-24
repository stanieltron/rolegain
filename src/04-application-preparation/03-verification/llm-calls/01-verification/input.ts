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

Return one verification for every supplied applicationId. Check every material candidate claim against the source evidence, ensure narrative answers address their exact fields, and keep unconfirmed personal facts empty.`;
}

export const inputDescription =
  "Original contexts, generated drafts, and deterministic pre-check findings.";
