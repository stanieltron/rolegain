import type { FormField } from "../../../../contracts/job-search.js";

export function buildInput(fields: FormField[]) {
  return `Map these extracted application fields:\n${JSON.stringify(
    fields.map((field) => ({
      fieldId: field.id,
      label: field.label,
      externalName: field.externalName,
      type: field.type,
      required: field.required,
      options: field.options || [],
    })),
    null,
    2,
  )}`;
}

export const inputDescription =
  "Observed form labels, names, types, options, and candidate facts.";
