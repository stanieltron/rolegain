import { describe, expect, it } from "vitest";
import type { JobOpportunity } from "../src/contracts/job-search.js";
import { vacanciesForMatching } from "../src/03-match/01-requirement-matching/llm-calls/01-requirement-matching/input.js";

describe("requirement-matching vacancy input", () => {
  it("falls back to the complete employer description when section headings are absent", () => {
    const description =
      "Build production agent systems. Candidates need strong TypeScript and distributed-systems experience.";
    const [vacancy] = vacanciesForMatching([
      {
        id: "job-1",
        company: "Example",
        title: "Agent Engineer",
        description,
        summary: description,
      } as JobOpportunity,
    ]);
    expect(vacancy.responsibilitiesText).toBe(description);
    expect(vacancy.qualificationText).toBe(description);
    expect(vacancy.responsibilitiesSource).toBe("full_description_fallback");
    expect(vacancy.qualificationSource).toBe("full_description_fallback");
  });
});
