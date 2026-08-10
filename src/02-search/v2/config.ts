export interface SearchV2Configuration {
  captureConcurrency: number;
  classificationBatchSize: number;
  classificationConcurrency: number;
  navigationTimeoutMs: number;
  settleMs: number;
  maxWaves: number;
  childrenPerSource: number;
}

export function searchV2Configuration(
  environment: NodeJS.ProcessEnv = process.env,
): SearchV2Configuration {
  return {
    captureConcurrency: boundedInteger(
      environment.ROLEGAIN_SEARCH_V2_CAPTURE_CONCURRENCY,
      10,
      1,
      16,
    ),
    classificationBatchSize: boundedInteger(
      environment.ROLEGAIN_SEARCH_V2_BATCH_SIZE,
      32,
      12,
      48,
    ),
    classificationConcurrency: boundedInteger(
      environment.ROLEGAIN_SEARCH_V2_CLASSIFICATION_CONCURRENCY,
      3,
      1,
      4,
    ),
    navigationTimeoutMs: boundedInteger(
      environment.ROLEGAIN_SEARCH_V2_NAVIGATION_TIMEOUT_MS,
      15_000,
      5_000,
      30_000,
    ),
    settleMs: boundedInteger(
      environment.ROLEGAIN_SEARCH_V2_SETTLE_MS,
      650,
      0,
      3_000,
    ),
    maxWaves: boundedInteger(
      environment.ROLEGAIN_SEARCH_V2_MAX_WAVES,
      4,
      1,
      6,
    ),
    childrenPerSource: boundedInteger(
      environment.ROLEGAIN_SEARCH_V2_CHILDREN_PER_SOURCE,
      20,
      1,
      20,
    ),
  };
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}
