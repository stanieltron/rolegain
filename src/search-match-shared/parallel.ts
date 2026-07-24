export function matchingConcurrency() {
  const configured = Number.parseInt(
    process.env.ROLEGAIN_MATCH_CONCURRENCY || "4",
    10,
  );
  return Number.isFinite(configured)
    ? Math.max(1, Math.min(8, configured))
    : 4;
}

export function vacancyValidationConcurrency() {
  const configured = Number.parseInt(
    process.env.ROLEGAIN_VACANCY_VALIDATION_CONCURRENCY || "6",
    10,
  );
  return Number.isFinite(configured)
    ? Math.max(1, Math.min(12, configured))
    : 6;
}

export async function mapParallelOrdered<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  const workerCount = Math.max(
    1,
    Math.min(items.length, Math.floor(concurrency) || 1),
  );
  let nextIndex = 0;
  let firstError: unknown;
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (firstError === undefined) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        try {
          results[index] = await mapper(items[index], index);
        } catch (error) {
          firstError ??= error;
        }
      }
    }),
  );
  if (firstError !== undefined) throw firstError;
  return results;
}
