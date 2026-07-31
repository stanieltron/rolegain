import { describe, expect, it } from "vitest";
import type {
  CandidateContradiction,
  EvidenceClaim,
} from "../src/contracts/evidence.js";
import type { CandidateProfile } from "../src/contracts/job-search.js";
import { applyEvidenceReviews } from "../src/search-match-shared/evidence-review.js";

const profile: CandidateProfile = {
  name: "Local user",
  email: "local@rolegain.invalid",
  phone: "",
  linkedin: "",
  github: "",
  website: "",
  location: "",
  headline: "Protocol architect",
  summary: "Evidence-backed profile",
  salaryExpectation: "",
  targetLocations: "",
  workplace: "Remote",
  employmentTypes: "",
  workAuthorization: "",
  startDate: "",
  skills: [],
  languages: [],
};

const claim = {
  claimId: "claim-weak",
  supportStatus: "weakly_supported",
} as EvidenceClaim;

const placeholderContradiction: CandidateContradiction = {
  contradictionId: "contradiction-placeholder",
  field: "name",
  explanation: "The profile contains a placeholder.",
  status: "open",
  values: [
    { value: "Local user", sourceId: "current-profile", quote: "Local user" },
    { value: "Stanislav Vozarik", sourceId: "cv", quote: "Stanislav Vozarik" },
  ],
};

describe("evidence review overlay", () => {
  it("hides placeholder contradictions without requiring user action", () => {
    const reviewed = applyEvidenceReviews(
      [claim],
      [placeholderContradiction],
      profile,
    );
    expect(reviewed.contradictions).toEqual([]);
  });

  it("removes rejected claims from the evidence used by matching", () => {
    const reviewed = applyEvidenceReviews(
      [claim],
      [],
      profile,
      {
        claims: [
          {
            claimId: claim.claimId,
            decision: "remove",
            reviewedAt: "2026-07-31T00:00:00.000Z",
          },
        ],
        contradictions: [],
      },
    );
    expect(reviewed.claims).toEqual([]);
  });

  it("keeps candidate confirmation separate from source support", () => {
    const reviewed = applyEvidenceReviews(
      [claim],
      [],
      profile,
      {
        claims: [
          {
            claimId: claim.claimId,
            decision: "candidate_confirmed",
            reviewedAt: "2026-07-31T00:00:00.000Z",
          },
        ],
        contradictions: [],
      },
    );
    expect(reviewed.claims[0]).toMatchObject({
      supportStatus: "weakly_supported",
      review: { decision: "candidate_confirmed" },
    });
  });
});
