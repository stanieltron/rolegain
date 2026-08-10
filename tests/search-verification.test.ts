import { describe, expect, it } from "vitest";
import {
  classifySearchValidationFailure,
  normalizeSearchValidationFailure,
} from "../src/02-search/v1/03-vacancy-validation/failure-classification.js";

describe("search-stage verification classification", () => {
  it.each([
    ["Job page returned 403", "manual_review", "access_restricted"],
    ["Blocked by robots.txt", "manual_review", "access_restricted"],
    ["Cloudflare security verification", "manual_review", "access_restricted"],
  ] as const)("marks access restrictions for manual review: %s", (reason, disposition, reasonCode) => {
    expect(classifySearchValidationFailure(reason, "vacancy_validation")).toEqual({
      disposition,
      reasonCode,
    });
  });

  it.each([
    ["Vacancy is closed", "closed_or_unavailable"],
    ["Vacancy valid-through date has passed", "closed_or_unavailable"],
    ["Workplace or location does not match the candidate constraint", "location_or_workplace"],
  ] as const)("keeps confirmed hard exclusions in rejected: %s", (reason, reasonCode) => {
    expect(classifySearchValidationFailure(reason, "vacancy_validation")).toEqual({
      disposition: "rejected",
      reasonCode,
    });
  });

  it.each([
    "Application link returned 404",
    "Employment type does not match the candidate preference",
  ])("retains nonterminal constraints or routing failures: %s", (reason) => {
    expect(classifySearchValidationFailure(reason, "vacancy_validation")).toEqual({
      disposition: "unresolved",
      reasonCode: "technical_failure",
    });
  });

  it("marks discovery/list pages separately", () => {
    expect(
      classifySearchValidationFailure(
        "Vacancy list contained no independently validated current positions",
        "vacancy_validation",
      ),
    ).toEqual({ disposition: "source_page", reasonCode: "not_a_vacancy" });
  });

  it.each([
    "page.goto: Download is starting",
    "Job page returned no response",
    "Application page did not expose enough content to verify the vacancy",
    "Only HTTP and HTTPS sources are supported",
  ])("keeps technical failures unresolved: %s", (reason) => {
    expect(classifySearchValidationFailure(reason, "vacancy_validation")).toEqual({
      disposition: "unresolved",
      reasonCode: "technical_failure",
    });
  });

  it("does not turn application-form mapping into a job rejection", () => {
    expect(classifySearchValidationFailure("Employer form could not be mapped", "form")).toEqual({
      disposition: "manual_review",
      reasonCode: "application_form",
    });
  });

  it("does not turn matching-verifier defects into search rejection", () => {
    expect(classifySearchValidationFailure("Requirement matrix is incomplete", "requirements")).toEqual({
      disposition: "unresolved",
      reasonCode: "matching_verification",
    });
  });

  it("tracks duplicate vacancies without rejecting them", () => {
    expect(
      classifySearchValidationFailure(
        "Duplicate of an already validated vacancy",
        "vacancy_validation",
      ),
    ).toEqual({ disposition: "duplicate", reasonCode: "duplicate" });
  });

  it("does not classify an unmistakable category page as a closed vacancy", () => {
    expect(
      normalizeSearchValidationFailure({
        id: "mev-list",
        company: "Web3.Career",
        title: "MEV Jobs",
        location: "Remote",
        sourceUrl: "https://web3.career/mev-jobs",
        applyUrl: "https://web3.career/mev-jobs",
        stage: "vacancy_validation",
        disposition: "rejected",
        reasonCode: "closed_or_unavailable",
        reason: "Page classified as closed_job; Vacancy is closed",
        capturedAt: "2026-07-17T00:00:00.000Z",
      }),
    ).toMatchObject({
      disposition: "source_page",
      reasonCode: "not_a_vacancy",
    });
  });
});
