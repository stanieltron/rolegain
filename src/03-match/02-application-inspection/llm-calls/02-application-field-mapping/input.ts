import type { ObservedApplicationField } from "../../../../search-match-shared/types.js";

export function buildInput(fields: ObservedApplicationField[]) {
  return `Read the rendered employer form below. The controls are an accessibility-style browser observation, not a trusted schema.

Return one logical field for every employer question. Give each logical field a unique, stable semantic fieldId; it does not need to equal a browser control id. Group alternative controls for the same answer (for example, a resume upload and its "enter manually" textarea) by listing all of their controlIds together. Every supplied control id must appear exactly once, either in one field's controlIds or in ignoredControlIds. Ignore only controls that are clearly presentation, cancel, navigation, or submission controls. Never ignore an ambiguous control.

Use visible nearby text to recover labels when HTML names, ids, placeholders, or accessibility labels are absent or generic. Treat "Not specified", "Choose", "Select", and similar placeholders as values, not question labels. Copy every visible answer choice into options; use an empty array for free-text and upload questions. Preserve the employer's requiredness. Do not answer any field.

Rendered controls:\n${JSON.stringify(
    fields.map((field) => ({
      controlIds: field.browserControlIds || [],
      extractedLabel: field.label,
      nativeName: field.externalName,
      tag: field.tag,
      inputType: field.inputType,
      placeholder: field.placeholder,
      nativeRequired: field.required,
      options: field.options,
      nearbyText: field.nearbyText || [],
      allowsManualEntry: field.allowsManualEntry,
    })),
    null,
    2,
  )}`;
}

export const inputDescription =
  "A live rendered-control observation with visible surrounding text and stable control ids.";
