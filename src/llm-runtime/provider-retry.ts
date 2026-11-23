import { setTimeout as delay } from "node:timers/promises";

export const PROVIDER_FAILURE_MESSAGE =
  "The AI provider could not complete this step after an automatic retry. Please try again.";

export function isTransientProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Authentication, invalid requests, cancellation and result validation need
  // intervention; repeating those requests only spends more time and tokens.
  const message = error.message;
  if (/cancel|abort|stopped|unauthoriz|not authenticated|revoked|invalid.*schema|quota|usage limit|billing/i.test(message))
    return false;
  return /(?:request failed|unexpected status).*\b(?:408|429|500|502|503|504)\b|rate.?limit|temporarily unavailable|server overloaded|stream disconnected|connection reset|ECONNRESET|ETIMEDOUT|fetch failed|(?:Codex exec|LLM API turn).*timed out/i.test(message);
}

/** Retry only the failed model turn, never the whole application workflow. */
export async function withProviderRetry<T>(
  attempt: () => Promise<T>,
  assertAllowed: () => void,
): Promise<T> {
  for (let index = 0; ; index += 1) {
    assertAllowed();
    try {
      return await attempt();
    } catch (error) {
      assertAllowed();
      if (!isTransientProviderError(error)) throw error;
      if (index === 1)
        throw new Error(PROVIDER_FAILURE_MESSAGE, { cause: error });
      await delay(2_000);
    }
  }
}
