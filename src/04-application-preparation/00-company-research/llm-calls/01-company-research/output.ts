export interface CompanyResearchOutput {
  company: string;
  overview: string;
  productsAndServices: string[];
  customersAndMarkets: string[];
  businessModel: string;
  cultureAndValues: string[];
  recentSignals: string[];
  tailoringAngles: string[];
  sources: Array<{
    title: string;
    url: string;
    evidence: string;
  }>;
}

const stringArray = {
  type: "array",
  items: { type: "string" },
} as const;

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "company",
    "overview",
    "productsAndServices",
    "customersAndMarkets",
    "businessModel",
    "cultureAndValues",
    "recentSignals",
    "tailoringAngles",
    "sources",
  ],
  properties: {
    company: { type: "string" },
    overview: { type: "string" },
    productsAndServices: stringArray,
    customersAndMarkets: stringArray,
    businessModel: { type: "string" },
    cultureAndValues: stringArray,
    recentSignals: stringArray,
    tailoringAngles: stringArray,
    sources: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url", "evidence"],
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
} as const;

export const outputDescription =
  "A sourced company overview, products, customers, business model, culture, recent signals, and role-specific tailoring angles.";
