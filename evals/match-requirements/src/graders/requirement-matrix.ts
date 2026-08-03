import type { RequirementMatch } from "../../../../src/contracts/job-search.js";
import type {
  MatchEvalGrade,
  MatchRequirementsEvalCase,
  RequirementRowGrade,
} from "../dataset/types.js";

export interface GradeableRequirementRow {
  requirement: string;
  category?: RequirementMatch["category"];
  matchClass?: RequirementMatch["matchClass"];
  status: RequirementMatch["status"];
  normalizedCapability?: string;
  evidence: Array<{
    claimId?: string;
    sourceId: string;
    excerpt: string;
  }>;
}

export function gradeMatchRequirements(input: {
  testCase: MatchRequirementsEvalCase;
  rows: GradeableRequirementRow[];
  claimIdByKey: Record<string, string>;
}): MatchEvalGrade {
  const reverseClaimKeys = new Map(
    Object.entries(input.claimIdByKey).map(([key, value]) => [value, key]),
  );
  const claimQuoteByKey = new Map(
    input.testCase.claims.map((claim) => [claim.key, normalizeExcerpt(claim.quote)]),
  );
  const used = new Set<number>();
  let totalCitations = 0;
  let validCitations = 0;
  const grades: RequirementRowGrade[] = input.testCase.expected.map((expected) => {
    const candidate = bestCandidate(
      expected.aliases,
      expected.category,
      input.rows,
      used,
    );
    if (!candidate)
      return {
        expectedId: expected.id,
        found: false,
        categoryPassed: false,
        matchClassPassed: false,
        evidencePassed: false,
        passed: false,
        reasons: ["Expected employer requirement was omitted"],
      };
    used.add(candidate.index);
    const row = candidate.row;
    const actualClass = row.matchClass || classFromStatus(row.status);
    const categoryPassed = row.category === expected.category;
    const matchClassPassed = expected.allowedMatchClasses.includes(actualClass);
    const actualClaimKeys = row.evidence
      .map((item) => item.claimId && reverseClaimKeys.get(item.claimId))
      .filter((value): value is string => Boolean(value));
    const unknownClaimIds = row.evidence
      .map((item) => item.claimId)
      .filter((id): id is string => Boolean(id && !reverseClaimKeys.has(id)));
    totalCitations += row.evidence.length;
    validCitations += row.evidence.filter((item) => {
      const key = item.claimId && reverseClaimKeys.get(item.claimId);
      return Boolean(
        key &&
          expected.allowedClaimKeys.includes(key) &&
          normalizeExcerpt(item.excerpt) === claimQuoteByKey.get(key) &&
          actualClass !== "unsupported" &&
          actualClass !== "contradicted",
      );
    }).length;
    const citationsAreExact = row.evidence.every((item) => {
      const key = item.claimId && reverseClaimKeys.get(item.claimId);
      return Boolean(
        key && normalizeExcerpt(item.excerpt) === claimQuoteByKey.get(key),
      );
    });
    const evidencePassed =
      unknownClaimIds.length === 0 &&
      citationsAreExact &&
      actualClaimKeys.every((key) => expected.allowedClaimKeys.includes(key)) &&
      (expected.allowedClaimKeys.length > 0 || row.evidence.length === 0) &&
      (actualClass === "unsupported" || actualClass === "contradicted"
        ? row.evidence.length === 0
        : row.evidence.length > 0);
    const reasons: string[] = [];
    if (!categoryPassed)
      reasons.push(`Expected category ${expected.category}, received ${row.category || "none"}`);
    if (!matchClassPassed)
      reasons.push(
        `Expected ${expected.allowedMatchClasses.join(" or ")}, received ${actualClass}`,
      );
    if (!evidencePassed)
      reasons.push(
        `Evidence keys [${actualClaimKeys.join(", ")}] were not valid for this requirement`,
      );
    return {
      expectedId: expected.id,
      generatedIndex: candidate.index,
      generatedRequirement: row.requirement,
      found: true,
      categoryPassed,
      matchClassPassed,
      evidencePassed,
      passed: categoryPassed && matchClassPassed && evidencePassed,
      reasons,
    };
  });
  const extras = input.rows
    .map((row, index) => ({ row, index }))
    .filter(({ index }) => !used.has(index))
    .map(({ row }) => row.requirement);
  totalCitations += input.rows
    .filter((_row, index) => !used.has(index))
    .reduce((count, row) => count + row.evidence.length, 0);
  const criticalFailures = grades
    .filter((grade) => {
      const expected = input.testCase.expected.find(
        (item) => item.id === grade.expectedId,
      );
      return expected?.critical && !grade.passed;
    })
    .map((grade) => grade.expectedId);
  const matched = grades.filter((grade) => grade.found).length;
  const passedRows = grades.filter((grade) => grade.passed).length;
  return {
    passed:
      grades.every((grade) => grade.passed) &&
      extras.length === 0 &&
      criticalFailures.length === 0,
    requirementRecall: ratio(matched, grades.length),
    requirementPrecision: ratio(matched, matched + extras.length),
    rowAccuracy: ratio(passedRows, grades.length),
    citationPrecision: ratio(validCitations, totalCitations, 1),
    criticalFailures,
    extraRequirements: extras,
    rows: grades,
  };
}

function bestCandidate(
  aliases: string[][],
  expectedCategory: NonNullable<RequirementMatch["category"]>,
  rows: GradeableRequirementRow[],
  used: Set<number>,
) {
  const candidates = rows.flatMap((row, index) => {
    if (used.has(index)) return [];
    const text = normalize(`${row.requirement} ${row.normalizedCapability || ""}`);
    const matchingAliases = aliases.filter((alias) =>
      alias.every((term) => hasTerm(text, normalize(term))),
    );
    if (!matchingAliases.length) return [];
    const longest = Math.max(...matchingAliases.map((alias) => alias.length));
    return [{
      row,
      index,
      score:
        longest * 10 +
        (row.category === expectedCategory ? 5 : 0),
    }];
  });
  return candidates.sort((left, right) => right.score - left.score)[0];
}

function normalizeExcerpt(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function hasTerm(text: string, term: string) {
  if (!term) return true;
  if (text.includes(term)) return true;
  if (term === "five" && /\b5\b/.test(text)) return true;
  return false;
}

function classFromStatus(status: RequirementMatch["status"]) {
  return status === "matched"
    ? ("explicit" as const)
    : status === "partial"
      ? ("strong_adjacent" as const)
      : ("unsupported" as const);
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();
}

function ratio(numerator: number, denominator: number, empty = 0) {
  return denominator === 0 ? empty : Math.round((numerator / denominator) * 1000) / 1000;
}
