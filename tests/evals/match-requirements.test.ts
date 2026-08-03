import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { matchRequirementsCorpus } from "../../evals/match-requirements/src/dataset/corpus.js";
import { gradeMatchRequirements } from "../../evals/match-requirements/src/graders/requirement-matrix.js";
import { prepareMatchEvalCase } from "../../evals/match-requirements/src/dataset/fixtures.js";
import {
  buildAssessmentChallenge,
  buildGoldAssessment,
} from "../../evals/match-requirements/src/graders/assessment-challenges.js";
import { gradeVerifier } from "../../evals/match-requirements/src/graders/verifier.js";

describe("match-requirements eval corpus", () => {
  it("has unique cases, claim keys, requirement labels, and resolvable gold citations", () => {
    expect(new Set(matchRequirementsCorpus.map((item) => item.id)).size).toBe(
      matchRequirementsCorpus.length,
    );
    expect(matchRequirementsCorpus).toHaveLength(52);
    expect(
      matchRequirementsCorpus.reduce(
        (total, testCase) => total + testCase.expected.length,
        0,
      ),
    ).toBe(110);
    for (const testCase of matchRequirementsCorpus) {
      const claimKeys = testCase.claims.map((item) => item.key);
      expect(new Set(claimKeys).size).toBe(claimKeys.length);
      expect(new Set(testCase.expected.map((item) => item.id)).size).toBe(
        testCase.expected.length,
      );
      for (const expected of testCase.expected) {
        expect(expected.requirement.trim()).not.toBe("");
        expect(expected.rationale.trim()).not.toBe("");
        expect(expected.aliases.length).toBeGreaterThan(0);
        expect(expected.aliases.every((alias) => alias.length > 0)).toBe(true);
        expect(
          expected.allowedClaimKeys.every((key) => claimKeys.includes(key)),
        ).toBe(true);
      }
      for (const route of testCase.knowledgeRoutes || []) {
        expect(claimKeys).toContain(route.claimKey);
        expect(route.retrievalTerms.length).toBeGreaterThan(0);
        expect(route.narrative.trim()).not.toBe("");
      }
    }
  });

  it("covers every declared family with balanced development and test splits", () => {
    const familyCounts = matchRequirementsCorpus.reduce<Record<string, number>>(
      (counts, item) => ({
        ...counts,
        [item.family]: (counts[item.family] || 0) + 1,
      }),
      {},
    );
    expect(familyCounts).toEqual({
      direct: 8,
      adjacent: 8,
      scope_ownership: 7,
      evidence_quality: 5,
      adversarial: 4,
      missing: 5,
      duration_quantity: 4,
      requirement_extraction: 5,
      citation_integrity: 4,
      knowledge_routing: 2,
    });
    expect(matchRequirementsCorpus.filter((item) => item.split === "development"))
      .toHaveLength(26);
    expect(matchRequirementsCorpus.filter((item) => item.split === "test"))
      .toHaveLength(26);
    expect(matchRequirementsCorpus.filter((item) => item.verifierChallenge))
      .toHaveLength(52);
    expect(matchRequirementsCorpus.filter((item) => item.repairChallenge).length)
      .toBeGreaterThanOrEqual(15);
  });

  it("constructs canonical fixtures and grades every gold assessment as correct", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "match-eval-gold-"));
    for (const testCase of matchRequirementsCorpus) {
      const prepared = await prepareMatchEvalCase(
        testCase,
        path.join(root, testCase.id),
      );
      const assessment = buildGoldAssessment(prepared);
      const grade = gradeMatchRequirements({
        testCase,
        rows: assessment.requirements,
        claimIdByKey: prepared.claimIdByKey,
      });
      expect(grade, testCase.id).toMatchObject({
        passed: true,
        requirementRecall: 1,
        requirementPrecision: 1,
        rowAccuracy: 1,
        citationPrecision: 1,
      });
      for (const route of testCase.knowledgeRoutes || []) {
        const claimId = prepared.claimIdByKey[route.claimKey];
        expect(
          prepared.knowledgeRoutesByJob[0].pages.some(
            (page) =>
              page.claimIds.includes(claimId) &&
              page.content.includes(route.narrative),
          ),
          `${testCase.id}: expected routed knowledge page for ${route.claimKey}`,
        ).toBe(true);
        expect(
          prepared.sourceLedger.some((citation) => citation.claimId === claimId),
          `${testCase.id}: routed claim missing from canonical ledger`,
        ).toBe(true);
      }
      if (testCase.verifierChallenge)
        expect(() =>
          buildAssessmentChallenge(prepared, testCase.verifierChallenge!),
        ).not.toThrow();
      if (testCase.repairChallenge)
        expect(() =>
          buildAssessmentChallenge(prepared, testCase.repairChallenge!),
        ).not.toThrow();
    }
  });

  it("scores verifier clean controls, targeted detections, and false negatives", () => {
    const clean = {
      assessment: { jobId: "job", requirements: [] },
      challenge: "clean_control" as const,
      expectedVerdict: "pass" as const,
      targetRequirement: "",
      description: "clean",
    };
    expect(
      gradeVerifier(clean, {
        jobId: "job",
        verdict: "pass",
        findings: [],
        repairInstructions: [],
      }).passed,
    ).toBe(true);
    const defective = {
      ...clean,
      challenge: "inflated_match" as const,
      expectedVerdict: "needs_repair" as const,
      targetRequirement: "Production Go experience is required",
    };
    expect(
      gradeVerifier(defective, {
        jobId: "job",
        verdict: "needs_repair",
        findings: [
          {
            code: "inflation",
            requirement: "Production Go experience",
            message: "Java evidence does not establish Go",
          },
        ],
        repairInstructions: ["Downgrade the row"],
      }).passed,
    ).toBe(true);
    expect(
      gradeVerifier(defective, {
        jobId: "job",
        verdict: "pass",
        findings: [],
        repairInstructions: [],
      }).passed,
    ).toBe(false);
  });

  it("passes a complete direct-match matrix", () => {
    const testCase = matchRequirementsCorpus.find(
      (item) => item.id === "direct-platform-match",
    )!;
    const claimIdByKey = { "workflow-platform": "claim-1" };
    const evidence = [
      {
        claimId: "claim-1",
        sourceId: "source-1",
        excerpt: testCase.claims[0].quote,
      },
    ];
    const grade = gradeMatchRequirements({
      testCase,
      claimIdByKey,
      rows: [
        {
          requirement: "Build TypeScript workflow orchestration",
          category: "responsibility",
          status: "matched",
          matchClass: "explicit",
          evidence,
        },
        {
          requirement: "Strong TypeScript experience",
          category: "mandatory",
          status: "matched",
          matchClass: "explicit",
          evidence,
        },
        {
          requirement: "Kubernetes experience",
          category: "preferred",
          status: "missing",
          matchClass: "unsupported",
          evidence: [],
        },
      ],
    });
    expect(grade.passed).toBe(true);
    expect(grade.rowAccuracy).toBe(1);
  });

  it("rejects inflated classes, invalid citations, omissions, and phantom rows", () => {
    const testCase = matchRequirementsCorpus.find(
      (item) => item.id === "production-scale-inflation",
    )!;
    const grade = gradeMatchRequirements({
      testCase,
      claimIdByKey: { "event-prototype": "claim-prototype" },
      rows: [
        {
          requirement: "Operate high-volume event infrastructure",
          category: "responsibility",
          status: "matched",
          matchClass: "explicit",
          evidence: [
            {
              claimId: "invented-claim",
              sourceId: "source-1",
              excerpt: "invented",
            },
          ],
        },
        {
          requirement: "Secret phantom requirement",
          category: "mandatory",
          status: "missing",
          matchClass: "unsupported",
          evidence: [],
        },
      ],
    });
    expect(grade.passed).toBe(false);
    expect(grade.requirementRecall).toBe(0.5);
    expect(grade.requirementPrecision).toBe(0.5);
    expect(grade.rowAccuracy).toBe(0);
    expect(grade.extraRequirements).toEqual(["Secret phantom requirement"]);
    expect(grade.criticalFailures).toEqual([
      "operate-high-volume",
      "measured-production-scale",
    ]);
  });

  it("does not reuse one generated row for multiple gold requirements", () => {
    const testCase = matchRequirementsCorpus.find(
      (item) => item.id === "extraction-duplicate-wording",
    )!;
    const grade = gradeMatchRequirements({
      testCase,
      claimIdByKey: { evidence: "claim-1" },
      rows: [
        {
          requirement: "SQL query-writing experience for analytics reporting",
          category: "responsibility",
          status: "matched",
          matchClass: "explicit",
          evidence: [
            {
              claimId: "claim-1",
              sourceId: "source-1",
              excerpt: testCase.claims[0].quote,
            },
          ],
        },
      ],
    });
    expect(grade.requirementRecall).toBe(0.5);
    expect(grade.passed).toBe(false);
  });

  it("rejects a correct claim id paired with an inexact excerpt", () => {
    const testCase = matchRequirementsCorpus.find(
      (item) => item.id === "citation-exact-excerpt",
    )!;
    const grade = gradeMatchRequirements({
      testCase,
      claimIdByKey: { evidence: "claim-1", distractor: "claim-2" },
      rows: [
        {
          requirement: testCase.expected[0].requirement,
          category: "responsibility",
          status: "matched",
          matchClass: "explicit",
          evidence: [
            {
              claimId: "claim-1",
              sourceId: "source-1",
              excerpt: testCase.claims[1].quote,
            },
          ],
        },
      ],
    });
    expect(grade.rows[0].evidencePassed).toBe(false);
    expect(grade.citationPrecision).toBe(0);
  });
});
