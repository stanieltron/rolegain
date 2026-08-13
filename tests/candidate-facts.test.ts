import { describe, expect, it } from "vitest";
import { reusableCandidateKey } from "../src/search-match-shared/candidate-facts.js";

describe("reusable candidate facts", () => {
  it("does not confuse third-party contact fields with candidate identity", () => {
    expect(
      reusableCandidateKey({
        canonicalKey: "name",
        label: "Referral Person (name)",
      }),
    ).toBeUndefined();
    expect(
      reusableCandidateKey({
        canonicalKey: "email",
        label: "Referrer email",
      }),
    ).toBeUndefined();
    expect(
      reusableCandidateKey({
        canonicalKey: "name",
        label: "Full name",
      }),
    ).toBe("name");
  });
});
