export const MATCH_REQUIREMENTS_RELEASE_THRESHOLDS = {
  dataset: {
    minimumCases: 52,
    minimumGoldRows: 110,
    humanReviewedRate: 1,
  },
  execution: {
    minimumTrialsPerCase: 3,
    requiredSuites: [
      "match.requirements.component",
      "match.tier2.component",
      "match.verification.component",
      "match.repair.component",
      "match.full-flow",
    ],
    runtimeCompatible: true,
  },
  reliability: {
    minimumPassAllTrialsRate: 0.95,
    maximumUnstableCaseRate: 0.05,
    // With 52 cases, 50/52 has a 95% Wilson lower bound of about 0.87.
    minimumPassAllTrialsLowerBound95: 0.85,
  },
  component: {
    requirementRecall: 0.98,
    requirementPrecision: 0.98,
    rowAccuracy: 0.95,
  },
  tier2: {
    passRate: 0.9,
    pipelineAcceptanceRate: 0.95,
    rowAccuracy: 0.95,
    citationPrecision: 0.99,
  },
  endToEnd: {
    passRate: 0.95,
    pipelineAcceptanceRate: 0.99,
    requirementRecall: 0.98,
    requirementPrecision: 0.98,
    rowAccuracy: 0.95,
    citationPrecision: 0.99,
    criticalSafetyRate: 1,
  },
  verifier: {
    defectRecall: 0.95,
    cleanSpecificity: 0.95,
    targetedFindingRate: 0.9,
  },
  repair: {
    passRate: 0.9,
    pipelineAcceptanceRate: 0.95,
    rowAccuracy: 0.95,
    citationPrecision: 0.99,
  },
  comparison: {
    semanticNonInferiorityMargin: -0.02,
  },
} as const;
