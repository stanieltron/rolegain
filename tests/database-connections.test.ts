import { describe, expect, it } from "vitest";
import {
  DEFAULT_DATABASE_POOL_SIZE,
  databasePoolSize,
} from "../src/infrastructure/database.js";
import {
  DEFAULT_WORKER_CONCURRENCY,
  DEFAULT_WORKFLOW_QUEUE_POOL_SIZE,
  workerConcurrency,
  workflowQueuePoolSize,
} from "../src/backend/workflows/workflow-queue.js";

describe("database connection budgets", () => {
  it("keeps the two-service deployment below a 15-client session pool", () => {
    const clientsPerService =
      DEFAULT_DATABASE_POOL_SIZE + DEFAULT_WORKFLOW_QUEUE_POOL_SIZE;

    expect(clientsPerService * 2).toBe(6);
    expect(clientsPerService * 4).toBeLessThanOrEqual(15);
  });

  it("allows positive environment overrides", () => {
    expect(
      databasePoolSize({ ROLEGAIN_DATABASE_POOL_SIZE: "4" }),
    ).toBe(4);
    expect(
      workflowQueuePoolSize({
        ROLEGAIN_WORKFLOW_QUEUE_POOL_SIZE: "3",
      }),
    ).toBe(3);
    expect(workerConcurrency({ ROLEGAIN_WORKER_CONCURRENCY: "2" })).toBe(2);
  });

  it("rejects zero, negative, and nonnumeric overrides", () => {
    expect(databasePoolSize({ ROLEGAIN_DATABASE_POOL_SIZE: "0" })).toBe(
      DEFAULT_DATABASE_POOL_SIZE,
    );
    expect(
      workflowQueuePoolSize({
        ROLEGAIN_WORKFLOW_QUEUE_POOL_SIZE: "-1",
      }),
    ).toBe(DEFAULT_WORKFLOW_QUEUE_POOL_SIZE);
    expect(workerConcurrency({ ROLEGAIN_WORKER_CONCURRENCY: "many" })).toBe(
      DEFAULT_WORKER_CONCURRENCY,
    );
  });
});
