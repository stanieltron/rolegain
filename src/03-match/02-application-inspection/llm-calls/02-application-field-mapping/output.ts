export interface ApplicationFieldMappingOutput {
  fields: Array<{ fieldId: string; canonicalKey: string }>;
}

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["fields"],
  properties: {
    fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fieldId", "canonicalKey"],
        properties: {
          fieldId: { type: "string" },
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
        },
      },
    },
  },
} as const;

export const outputDescription =
  "One canonical-key mapping for every observed field id.";
