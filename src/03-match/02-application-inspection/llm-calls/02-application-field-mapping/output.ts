export interface ApplicationFieldMappingOutput {
  fields: Array<{
    fieldId: string;
    controlIds: string[];
    label: string;
    canonicalKey: string;
    type: "text" | "email" | "tel" | "textarea" | "select" | "file" | "date" | "checkbox";
    required: boolean;
    options: string[];
  }>;
  ignoredControlIds: string[];
}

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["fields", "ignoredControlIds"],
  properties: {
    fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "fieldId",
          "controlIds",
          "label",
          "canonicalKey",
          "type",
          "required",
          "options",
        ],
        properties: {
          fieldId: { type: "string" },
          controlIds: {
            type: "array",
            items: { type: "string" },
          },
          label: { type: "string" },
          canonicalKey: {
            type: "string",
            enum: [
              "name", "first_name", "last_name", "email", "phone", "cv",
              "phone_country_code", "current_location", "city", "state",
              "intended_work_location", "country", "start_date", "notice_period",
              "education_start_month", "education_start_year",
              "education_end_month", "education_end_year",
              "work_authorization", "sponsorship", "linkedin", "github", "website",
              "cover_letter", "target_position", "job_source", "additional_information",
              "eeoc_gender", "eeoc_ethnicity", "eeoc_race", "eeoc_veteran_status",
              "eeoc_disability_status", "other",
            ],
          },
          type: {
            type: "string",
            enum: [
              "text", "email", "tel", "textarea", "select", "file",
              "date", "checkbox",
            ],
          },
          required: { type: "boolean" },
          options: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    },
    ignoredControlIds: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

export const outputDescription =
  "A complete logical form model that accounts for every rendered control id.";
