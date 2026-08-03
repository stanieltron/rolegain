export const searchOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["jobs"],
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title", "company", "location", "workplaceType",
          "employmentType", "url", "sourceKind", "query",
          "sourceClass", "snippet", "compensation",
        ],
        properties: {
          title: { type: "string" },
          company: { type: "string" },
          location: { type: "string" },
          workplaceType: { type: "string" },
          employmentType: { type: "string" },
          url: { type: "string" },
          sourceKind: { type: "string", enum: ["vacancy", "job_list"] },
          query: { type: "string" },
          sourceClass: { type: "string" },
          snippet: { type: "string" },
          compensation: { type: "string" },
        },
      },
    },
  },
} as const;

export const classificationOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id", "status", "reason", "title", "company", "location",
          "workplaceType", "employmentType", "applyUrl", "compensation",
          "children",
        ],
        properties: {
          id: { type: "string" },
          status: {
            type: "string",
            enum: ["vacancy", "job_list", "reject"],
          },
          reason: { type: "string" },
          title: { type: "string" },
          company: { type: "string" },
          location: { type: "string" },
          workplaceType: { type: "string" },
          employmentType: { type: "string" },
          applyUrl: { type: "string" },
          compensation: { type: "string" },
          children: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "company", "url"],
              properties: {
                title: { type: "string" },
                company: { type: "string" },
                url: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const;

