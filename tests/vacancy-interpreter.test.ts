import { describe, expect, it } from "vitest";
import {
  interpretationFromStructuredData,
  structuredVacancyIsComplete,
  validateListingVacancyLead,
  validateVacancyInterpretation,
  type VacancyPageSnapshot,
} from "../src/02-search/v1/03-vacancy-validation/interpreter.js";

function snapshot(
  overrides: Partial<VacancyPageSnapshot["structured"]> = {},
): VacancyPageSnapshot {
  const description =
    "Install and maintain electrical systems in commercial buildings. Applicants need a valid electrical qualification and relevant practical experience.";
  return {
    pageUrl: "https://jobs.example.test/electrician-1",
    pageTitle: "Electrician - Example Energy",
    metaDescription: description,
    h1: "Electrician",
    headings: ["Electrician", "Requirements"],
    bodyText: `Example Energy Electrician ${description} Apply now`,
    applyLinks: [
      {
        text: "Apply now",
        url: "https://jobs.example.test/electrician-1/apply",
      },
    ],
    links: [
      {
        text: "Electrician",
        url: "https://jobs.example.test/electrician-1",
      },
      {
        text: "Apply now",
        url: "https://jobs.example.test/electrician-1/apply",
      },
    ],
    structured: {
      hasJobPosting: true,
      title: "Electrician",
      company: "Example Energy",
      location: "Kosice, Slovakia",
      workplaceType: "On-site",
      employmentType: "FULL_TIME",
      description,
      datePosted: "2026-07-01",
      validThrough: "2999-01-01",
      applyUrl: "https://jobs.example.test/electrician-1/apply",
      ...overrides,
    },
  };
}

describe("hybrid vacancy interpretation", () => {
  it("uses complete JobPosting data without requiring semantic fallback", () => {
    const captured = snapshot();
    expect(structuredVacancyIsComplete(captured)).toBe(true);
    const interpretation = interpretationFromStructuredData(captured);
    expect(interpretation).toMatchObject({
      pageType: "vacancy",
      openStatus: "open",
      title: "Electrician",
      company: "Example Energy",
    });
    expect(validateVacancyInterpretation(captured, interpretation)).toEqual({
      passed: true,
      failures: [],
    });
  });

  it("marks expired structured vacancies as closed", () => {
    const captured = snapshot({ validThrough: "2000-01-01" });
    const interpretation = interpretationFromStructuredData(captured);
    expect(interpretation.openStatus).toBe("closed");
    expect(validateVacancyInterpretation(captured, interpretation).passed).toBe(
      false,
    );
  });

  it("rejects an application URL invented outside the captured snapshot", () => {
    const captured = snapshot({ hasJobPosting: false });
    const interpretation = {
      ...interpretationFromStructuredData(snapshot()),
      applyUrl: "https://attacker.example/apply",
    };
    const result = validateVacancyInterpretation(captured, interpretation);
    expect(result.passed).toBe(false);
    expect(result.failures).toContain(
      "Application URL was not present in the captured page",
    );
  });

  it("accepts traceable excerpts even when the interpreter labels or quotes them", () => {
    const captured = snapshot();
    const interpretation = {
      ...interpretationFromStructuredData(captured),
      evidence: [
        {
          field: "title",
          sourceText: 'pageTitle: "Electrician - Example Energy"',
        },
        {
          field: "applyUrl",
          sourceText:
            'applyLinks: [{"text":"Apply now","url":"https://jobs.example.test/electrician-1/apply"}]',
        },
      ],
    };
    expect(validateVacancyInterpretation(captured, interpretation)).toEqual({
      passed: true,
      failures: [],
    });
  });

  it("accepts a concrete same-page vacancy with a shared captured application form", () => {
    const captured = snapshot({ hasJobPosting: false });
    const result = validateListingVacancyLead(captured, {
      title: "Electrician",
      company: "Example Energy",
      location: "Kosice, Slovakia",
      workplaceType: "On-site",
      employmentType: "Full-time",
      description: captured.structured.description,
      compensation: "",
      jobUrl: captured.pageUrl,
      applyUrl: captured.applyLinks[0].url,
      openStatus: "open",
      publishedAt: "",
      validThrough: "",
      evidence: [{ field: "title", sourceText: "Electrician" }],
    });
    expect(result).toEqual({ passed: true, failures: [] });
  });

  it("does not treat an old publication date as proof of closure", () => {
    const captured = snapshot({ hasJobPosting: false });
    const result = validateListingVacancyLead(captured, {
      title: "Electrician",
      company: "Example Energy",
      location: "Kosice, Slovakia",
      workplaceType: "On-site",
      employmentType: "Full-time",
      description: captured.structured.description,
      compensation: "",
      jobUrl: captured.pageUrl,
      applyUrl: captured.applyLinks[0].url,
      openStatus: "open",
      publishedAt: "2024-01-01",
      validThrough: "",
      evidence: [],
    });
    expect(result).toEqual({ passed: true, failures: [] });
  });

  it("does not reject a live vacancy for unsupported optional date metadata", () => {
    const captured = snapshot({ hasJobPosting: false, validThrough: "" });
    const interpretation = {
      ...interpretationFromStructuredData(snapshot()),
      validThrough: "2000-01-01",
      evidence: [
        { field: "publishedAt", sourceText: "Published yesterday" },
        { field: "validThrough", sourceText: "Valid through 2000-01-01" },
      ],
    };
    expect(validateVacancyInterpretation(captured, interpretation)).toEqual({
      passed: true,
      failures: [],
    });
  });

  it("still rejects an invented child URL regardless of publication date", () => {
    const captured = snapshot({ hasJobPosting: false });
    const result = validateListingVacancyLead(captured, {
      title: "Electrician",
      company: "Example Energy",
      location: "Kosice, Slovakia",
      workplaceType: "On-site",
      employmentType: "Full-time",
      description: captured.structured.description,
      compensation: "",
      jobUrl: "https://invented.example.test/job",
      applyUrl: "",
      openStatus: "open",
      publishedAt: "2024-01-01",
      validThrough: "",
      evidence: [],
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("Vacancy URL was not present in the captured page");
  });

  it("accepts field-supported evidence when an interpreter reformats the excerpt", () => {
    const captured = snapshot({ hasJobPosting: false, applyUrl: "" });
    const interpretation = {
      ...interpretationFromStructuredData(snapshot()),
      evidence: [
        { field: "location", sourceText: "Location: Kosice, Slovakia" },
        { field: "workplaceType", sourceText: "Workplace type: On-site" },
        { field: "applyUrl", sourceText: captured.pageUrl },
      ],
      applyUrl: captured.pageUrl,
    };
    expect(validateVacancyInterpretation(captured, interpretation)).toEqual({
      passed: true,
      failures: [],
    });
  });
});
