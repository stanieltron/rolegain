import type { buildApplicationContext } from "../../../01-context/index.js";
import type {
  ApplicationContentDraft,
  ApplicationDraftVerification,
} from "../../../types.js";

type ApplicationContext = Awaited<ReturnType<typeof buildApplicationContext>>;

export function buildInput(input: {
  contexts: ApplicationContext[];
  drafts: ApplicationContentDraft[];
  failures: ApplicationDraftVerification[];
}) {
  const failedIds = new Set(
    input.failures.map((item) => item.applicationId),
  );
  return `Repair the failed application drafts using only the supplied context and verifier findings.

Application contexts:
${JSON.stringify(
  input.contexts.filter((item) => failedIds.has(item.applicationId)),
  null,
  2,
)}

Current drafts:
${JSON.stringify(
  input.drafts.filter((item) => failedIds.has(item.applicationId)),
  null,
  2,
)}

Verifier findings:
${JSON.stringify(input.failures, null, 2)}`;
}

export const inputDescription =
  "Failed contexts, current drafts, and verifier findings.";
