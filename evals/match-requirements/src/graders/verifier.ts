import type { AssessmentVerification } from "../../../../src/03-match/shared/01-requirement-matching/index.js";
import type { AssessmentChallenge } from "./assessment-challenges.js";

export interface VerifierEvalGrade {
  passed: boolean;
  expectedVerdict: "pass" | "needs_repair";
  actualVerdict: "pass" | "needs_repair" | "missing";
  verdictPassed: boolean;
  targetedFindingPassed: boolean;
  findings: AssessmentVerification["findings"];
  reasons: string[];
}

export function gradeVerifier(
  challenge: AssessmentChallenge,
  verification: AssessmentVerification | undefined,
): VerifierEvalGrade {
  const actualVerdict = verification?.verdict || "missing";
  const verdictPassed = actualVerdict === challenge.expectedVerdict;
  const targetedFindingPassed =
    challenge.expectedVerdict === "pass"
      ? (verification?.findings.length || 0) === 0
      : Boolean(
          verification?.findings.some((finding) =>
            findingTargetsRequirement(
              `${finding.requirement} ${finding.message}`,
              challenge.targetRequirement,
            ),
          ),
        );
  const reasons: string[] = [];
  if (!verdictPassed)
    reasons.push(`Expected ${challenge.expectedVerdict}, received ${actualVerdict}`);
  if (!targetedFindingPassed)
    reasons.push(
      challenge.expectedVerdict === "pass"
        ? "Clean control produced findings"
        : "No finding targeted the seeded defect",
    );
  return {
    passed: verdictPassed && targetedFindingPassed,
    expectedVerdict: challenge.expectedVerdict,
    actualVerdict,
    verdictPassed,
    targetedFindingPassed,
    findings: verification?.findings || [],
    reasons,
  };
}

function findingTargetsRequirement(finding: string, target: string) {
  const targetTokens = tokens(target);
  if (!targetTokens.length) return false;
  const findingTokens = new Set(tokens(finding));
  const overlap = targetTokens.filter((token) => findingTokens.has(token)).length;
  return overlap / targetTokens.length >= 0.35;
}

function tokens(value: string) {
  const stop = new Set([
    "and", "the", "for", "with", "must", "required", "experience", "candidate",
    "build", "develop", "perform", "provide", "using", "every", "requirement",
  ]);
  return [...new Set(
    value.toLowerCase().split(/[^a-z0-9+#]+/).filter(
      (token) => token.length >= 3 && !stop.has(token),
    ),
  )];
}
