export interface ConfidenceInterval {
  confidenceLevel: 0.95;
  lower: number;
  upper: number;
  method: "wilson-score" | "paired-bootstrap";
}

export interface CaseReliabilitySummary {
  caseCount: number;
  minimumTrialsPerCase: number;
  maximumTrialsPerCase: number;
  passAllTrialsRate: number | null;
  passAllTrialsRateCi95: ConfidenceInterval | null;
  passAtLeastOnceRate: number | null;
  unstableCaseRate: number | null;
}

export function summarizeCaseReliability(
  trials: Array<{ caseId: string; passed: boolean }>,
): CaseReliabilitySummary {
  const byCase = new Map<string, Array<{ caseId: string; passed: boolean }>>();
  for (const trial of trials)
    byCase.set(trial.caseId, [...(byCase.get(trial.caseId) || []), trial]);
  const cases = [...byCase.values()];
  if (!cases.length) {
    return {
      caseCount: 0,
      minimumTrialsPerCase: 0,
      maximumTrialsPerCase: 0,
      passAllTrialsRate: null,
      passAllTrialsRateCi95: null,
      passAtLeastOnceRate: null,
      unstableCaseRate: null,
    };
  }
  const passAllTrials = cases.filter((items) => items.every((item) => item.passed)).length;
  const passAtLeastOnce = cases.filter((items) => items.some((item) => item.passed)).length;
  const repeated = cases.filter((items) => items.length > 1);
  const unstable = repeated.filter(
    (items) => new Set(items.map((item) => item.passed)).size > 1,
  ).length;
  return {
    caseCount: cases.length,
    minimumTrialsPerCase: Math.min(...cases.map((items) => items.length)),
    maximumTrialsPerCase: Math.max(...cases.map((items) => items.length)),
    passAllTrialsRate: round(passAllTrials / cases.length),
    passAllTrialsRateCi95: wilsonScoreInterval(passAllTrials, cases.length),
    passAtLeastOnceRate: round(passAtLeastOnce / cases.length),
    unstableCaseRate: repeated.length ? round(unstable / repeated.length) : null,
  };
}

/** Two-sided Wilson score interval for a binary rate. */
export function wilsonScoreInterval(
  successes: number,
  total: number,
): ConfidenceInterval | null {
  if (!Number.isInteger(successes) || !Number.isInteger(total))
    throw new Error("Wilson interval counts must be integers");
  if (total < 1 || successes < 0 || successes > total) return null;
  const z = 1.959963984540054;
  const rate = successes / total;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = (rate + zSquared / (2 * total)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((rate * (1 - rate) + zSquared / (4 * total)) / total);
  return {
    confidenceLevel: 0.95,
    lower: round(Math.max(0, center - margin)),
    upper: round(Math.min(1, center + margin)),
    method: "wilson-score",
  };
}

/**
 * Deterministic paired bootstrap over task-level deltas. Inputs must already be
 * paired by case; resampling individual model trials would overstate certainty.
 */
export function pairedBootstrapInterval(
  differences: number[],
  iterations = 10_000,
): ConfidenceInterval | null {
  if (!differences.length) return null;
  if (differences.some((value) => !Number.isFinite(value)))
    throw new Error("Bootstrap differences must be finite numbers");
  if (differences.length === 1) {
    const value = round(differences[0]);
    return {
      confidenceLevel: 0.95,
      lower: value,
      upper: value,
      method: "paired-bootstrap",
    };
  }
  const random = mulberry32(hashNumbers(differences));
  const means = new Array<number>(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < differences.length; index += 1) {
      total += differences[Math.floor(random() * differences.length)];
    }
    means[iteration] = total / differences.length;
  }
  means.sort((left, right) => left - right);
  return {
    confidenceLevel: 0.95,
    lower: round(quantile(means, 0.025)),
    upper: round(quantile(means, 0.975)),
    method: "paired-bootstrap",
  };
}

function quantile(sorted: number[], probability: number) {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function hashNumbers(values: number[]) {
  let hash = 2166136261;
  for (const value of values) {
    const text = value.toPrecision(12);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
}

function mulberry32(seed: number) {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
