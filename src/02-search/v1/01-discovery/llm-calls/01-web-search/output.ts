export const outputDescription =
  "Typed leads: concrete vacancies plus relevant vacancy-search sources that can be expanded through persisted cursors; every URL, source class, query, and snippet remains explicit.";

export interface WebSearchLead {
  company: string;
  title: string;
  location: string;
  workplaceType: string;
  employmentType: string;
  sourceKind: "vacancy" | "job_list" | "career_page";
  jobUrl: string;
  applyUrl: string;
  description: string;
  compensation: string;
  discoveryQuery: string;
  sourceClass: string;
}

export interface WebSearchOutput {
  jobs: WebSearchLead[];
}

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["jobs"],
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["company", "title", "location", "workplaceType", "employmentType", "sourceKind", "jobUrl", "applyUrl", "description", "compensation", "discoveryQuery", "sourceClass"],
        properties: {
          company: { type: "string" }, title: { type: "string" }, location: { type: "string" },
          workplaceType: { type: "string" }, employmentType: { type: "string" },
          sourceKind: { type: "string", enum: ["vacancy", "job_list", "career_page"] },
          jobUrl: { type: "string" }, applyUrl: { type: "string" }, description: { type: "string" },
          compensation: { type: "string" }, discoveryQuery: { type: "string" },
          sourceClass: { type: "string", enum: ["employer_career", "employer_ats", "specialist_board", "local_board", "general_aggregator", "search_engine", "employer_directory"] },
        },
      },
    },
  },
} as const;
