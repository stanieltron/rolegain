import type { FormField } from "../../../../contracts/job-search.js";
import type { buildApplicationContext } from "../../../01-context/index.js";

type ApplicationContext = Awaited<ReturnType<typeof buildApplicationContext>>;

export function buildInput(input: {
  field: FormField;
  message: string;
  context: ApplicationContext;
}) {
  return `Revise one open-ended employer answer in response to the user's instruction.

Target field:
${JSON.stringify(
  {
    fieldId: input.field.id,
    label: input.field.label,
    currentValue: input.field.value,
    currentEvidenceBasis: input.field.evidence ?? "",
  },
  null,
  2,
)}

User instruction:
${input.message}

Application and grounded evidence:
${JSON.stringify(input.context, null, 2)}

Return the complete revised answer and a concise evidenceBasis identifying the supplied source facts that support it. Do not add unsupported claims.`;
}

export const inputDescription =
  "Target field, user instruction, current answer, and grounded context.";
