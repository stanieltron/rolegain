import { describe, expect, it } from "vitest";
import {
  deterministicListingVacancyLeads,
  preferVisibleActiveVacancy,
} from "../src/02-search/03-vacancy-validation/index.js";
import type { VacancyPageSnapshot } from "../src/02-search/03-vacancy-validation/interpreter.js";
import type { LiveCandidate } from "../src/search-match-shared/types.js";

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

  it("keeps a concrete vacancy open when a stale status conflicts with an active apply route", () => {
    const captured = listingSnapshot([
      {
        text: "Apply now",
        url: "https://jobs.example.test/principal-architect/apply",
      },
    ]);
    captured.pageUrl = "https://jobs.example.test/principal-architect";
    captured.h1 = "Principal Solution Architect, AI Agents";
    captured.bodyText =
      "Principal Solution Architect, AI Agents. Design production agent platforms and lead customer architecture. Apply now. ".repeat(
        4,
      );
    captured.applyLinks = captured.links;
    const candidate = {
      company: "Example",
      preliminaryFit: 50,
      job: {
        id: "principal",
        title: "Principal Solution Architect, AI Agents",
        jobUrl: captured.pageUrl,
        applyUrl: captured.applyLinks[0].url,
        sourceKind: "vacancy",
      },
    } as LiveCandidate;
    const result = preferVisibleActiveVacancy(captured, candidate, {
      pageType: "closed_job",
      openStatus: "closed",
      title: candidate.job.title,
      company: candidate.company,
      location: "Remote",
      workplaceType: "Remote",
      employmentType: "Full-time",
      description: captured.bodyText,
      compensation: "",
      applyUrl: candidate.job.applyUrl,
      publishedAt: "",
      validThrough: "2025-01-01",
      confidence: 80,
      ambiguities: [],
      evidence: [],
    });
    expect(result).toMatchObject({
      pageType: "vacancy",
      openStatus: "open",
      validThrough: "",
    });
  });
});
