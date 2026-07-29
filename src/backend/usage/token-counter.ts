import type { Pool } from "pg";
import type { CodexRunObservation } from "../../codex-runtime/client.js";

export interface TokenUsageContext {
  userId: string;
}

export interface UserTokenUsage {
  totalTokens: number;
}

export interface TokenCounter {
  record(
    context: TokenUsageContext,
    observation: CodexRunObservation,
  ): Promise<void>;
  get(userId: string): Promise<UserTokenUsage>;
}

export class PostgresTokenCounter implements TokenCounter {
  constructor(private readonly pool: Pool) {}

  async record(
    context: TokenUsageContext,
    observation: CodexRunObservation,
  ) {
    const tokens = totalTokens(observation.usage);
    if (tokens <= 0) return;
    const idempotencyKey = `${observation.threadId}:${observation.turnId}`;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const receipt = await client.query(
        `insert into rolegain_token_usage_receipts
           (idempotency_key, user_id, tokens)
         values ($1, $2, $3)
         on conflict (idempotency_key) do nothing
         returning idempotency_key`,
        [idempotencyKey, context.userId, tokens],
      );
      if (receipt.rowCount) {
        await client.query(
          `insert into rolegain_user_token_usage
             (user_id, total_tokens, updated_at)
           values ($1, $2, now())
           on conflict (user_id) do update
           set total_tokens =
                 rolegain_user_token_usage.total_tokens + excluded.total_tokens,
               updated_at = now()`,
          [context.userId, tokens],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(userId: string) {
    const result = await this.pool.query<{ total_tokens: string }>(
      "select total_tokens from rolegain_user_token_usage where user_id = $1",
      [userId],
    );
    return {
      totalTokens: Number(result.rows[0]?.total_tokens ?? 0),
    };
  }
}

export class MemoryTokenCounter implements TokenCounter {
  private readonly totals = new Map<string, number>();
  private readonly receipts = new Set<string>();

  async record(
    context: TokenUsageContext,
    observation: CodexRunObservation,
  ) {
    const key = `${observation.threadId}:${observation.turnId}`;
    if (this.receipts.has(key)) return;
    this.receipts.add(key);
    this.totals.set(
      context.userId,
      (this.totals.get(context.userId) ?? 0) + totalTokens(observation.usage),
    );
  }

  async get(userId: string) {
    return { totalTokens: this.totals.get(userId) ?? 0 };
  }
}

export function totalTokens(usage: Record<string, unknown>) {
  const direct = numeric(
    usage.total_tokens ??
      usage.totalTokens ??
      usage.total_token_count ??
      usage.totalTokenCount,
  );
  if (direct !== undefined) return direct;
  const input = numeric(
    usage.prompt_tokens ??
      usage.input_tokens ??
      usage.promptTokenCount ??
      usage.inputTokens,
  );
  const output = numeric(
    usage.completion_tokens ??
      usage.output_tokens ??
      usage.candidatesTokenCount ??
      usage.outputTokens,
  );
  return (input ?? 0) + (output ?? 0);
}

function numeric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}
