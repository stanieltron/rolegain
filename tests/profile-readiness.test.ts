import { describe, expect, it } from "vitest";
import type { JobSearchWorkspace } from "../src/contracts/job-search.js";
import { profileEvidenceNeedsAnalysis, sourceErrorMessage } from "../src/ui/profile-readiness.js";

function readyProfile(): Pick<JobSearchWorkspace, "intelligence" | "sources"> {
  return {
    intelligence: {
      status: "ready",
      evidenceRun: {
        id: "run", readyForSearch: true, blockers: [], warnings: [],
        counts: { sources: 2, sourceBlocks: 1, claims: 1, supportedClaims: 1, capabilities: 1, roleFamilies: 1, unknowns: 0, contradictions: 0 },
      },
    },
    sources: [
      { id: "cv", name: "CV", kind: "cv", status: "ready", insights: [], addedAt: "" },
      { id: "extra", name: "Scopus", kind: "webpage", status: "analysis_failed", analysisRequired: false, insights: [], addedAt: "", error: "Too many redirects while reading the source" },
    ],
  };
}

describe("profile progression after supplemental-source failure", () => {
  it("allows a ready profile with a failed optional source to reach job preferences", () => {
    expect(profileEvidenceNeedsAnalysis(readyProfile(), false)).toBe(false);
  });
  it("still blocks failed CVs, staged evidence, and sources requiring analysis", () => {
    const w = readyProfile();
    expect(profileEvidenceNeedsAnalysis(w, true)).toBe(true);
    w.sources[1]!.analysisRequired = true;
    expect(profileEvidenceNeedsAnalysis(w, false)).toBe(true);
    w.sources[1]!.analysisRequired = false;
    w.sources[0]!.status = "analysis_failed";
    expect(profileEvidenceNeedsAnalysis(w, false)).toBe(true);
  });
  it("does not ignore an unready or failed evidence analysis", () => {
    const w = readyProfile();
    w.intelligence.evidenceRun!.readyForSearch = false;
    expect(profileEvidenceNeedsAnalysis(w, false)).toBe(true);
    w.intelligence.evidenceRun!.readyForSearch = true;
    w.intelligence.status = "failed";
    expect(profileEvidenceNeedsAnalysis(w, false)).toBe(true);
  });
  it("explains persisted redirect errors without hiding other failures", () => {
    expect(sourceErrorMessage("Too many redirects while reading the source")).toContain("more direct link");
    expect(sourceErrorMessage("Could not read example.com (403)")).toBe("Could not read example.com (403)");
  });
});
