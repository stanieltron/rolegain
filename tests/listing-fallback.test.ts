import { describe, expect, it } from "vitest";
import { deterministicListingVacancyLeads } from "../src/02-search/03-vacancy-validation/index.js";
import type { VacancyPageSnapshot } from "../src/02-search/03-vacancy-validation/interpreter.js";

function listingSnapshot(links: VacancyPageSnapshot["links"]): VacancyPageSnapshot {
  return {
    pageUrl: "https://job-boards.greenhouse.io/ritual",
    pageTitle: "Jobs at Ritual",
    metaDescription: "Current openings",
    h1: "Current openings at Ritual",
    headings: ["15 jobs", "Engineering"],
    bodyText: "Core Protocol Engineer Remote Distributed Systems Engineer Remote",
    applyLinks: [],
    links,
    structured: {
      hasJobPosting: false,
      title: "",
      company: "",
      location: "",
      workplaceType: "",
      employmentType: "",
      description: "",
      datePosted: "",
      validThrough: "",
      applyUrl: "",
    },
  };
}

describe("deterministic listing expansion", () => {
  it("keeps concrete ATS vacancy links and ignores navigation", () => {
    const leads = deterministicListingVacancyLeads(
      listingSnapshot([
        { text: "Engineering", url: "https://job-boards.greenhouse.io/ritual#engineering" },
        { text: "Core Protocol Engineer", url: "https://job-boards.greenhouse.io/ritual/jobs/4614221007" },
        { text: "Apply", url: "https://job-boards.greenhouse.io/ritual/jobs/4614221007#app" },
        { text: "Distributed Systems Engineer", url: "https://job-boards.greenhouse.io/ritual/jobs/4609616007" },
      ]),
      "Ritual",
    );
    expect(leads.map((lead) => lead.title)).toEqual([
      "Core Protocol Engineer",
      "Distributed Systems Engineer",
    ]);
  });

  it("does not invent a vacancy for an inactive board", () => {
    expect(
      deterministicListingVacancyLeads(
        listingSnapshot([
          { text: "Page not found", url: "https://job-boards.greenhouse.io/burnt?error=true" },
        ]),
        "XION",
      ),
    ).toEqual([]);
  });
});
