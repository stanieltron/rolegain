import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import type { JobSearchService } from "../control-flow/service.js";
import type { ArtifactArchive } from "../persistence/artifact-archive.js";
import { withUserLock } from "../../infrastructure/database.js";
import {
  BETA_BATCH_SIZE,
  type PlatformControl,
} from "../admin/platform-control.js";

const QUEUE = "rolegain-workflows";
export const DEFAULT_WORKFLOW_QUEUE_POOL_SIZE = 1;
export const DEFAULT_WORKER_CONCURRENCY = 1;

export type WorkflowType =
  | "analyze"
  | "prepare"
  | "prepare-search-ready"
  | "find-more"
  | "tailor-cv";

interface WorkflowPayload {
  runId: string;
  userId: string;
  type: WorkflowType;
  resourceId?: string;
}

export interface WorkflowRun {
  id: string;
  type: WorkflowType;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  cancellationRequestedAt?: string;
}

export interface WorkflowQueue {
  start(processJobs: boolean): Promise<void>;
  enqueue(
    userId: string,
    type: WorkflowType,
    options?: { resourceId?: string; reserveBetaBatch?: boolean },
  ): Promise<WorkflowRun>;
  latest(userId: string): Promise<WorkflowRun | undefined>;
  cancel(userId: string): Promise<void>;
  close(): Promise<void>;
}

export class PostgresWorkflowQueue implements WorkflowQueue {
  private readonly boss: PgBoss;

  constructor(
    connectionString: string,
    private readonly pool: Pool,
    private readonly lockPool: Pool,
    private readonly service: JobSearchService,
    private readonly codex: CodexExecClient,
    private readonly artifacts: ArtifactArchive,
    private readonly platform: PlatformControl,
  ) {
    this.boss = new PgBoss({
      connectionString,
      max: workflowQueuePoolSize(),
      connectionTimeoutMillis: 10_000,
      application_name: "rolegain-workflow-queue",
    });
    this.boss.on("error", (error) =>
      console.error("Rolegain workflow queue error", error),
    );
  }

  async start(processJobs: boolean) {
    await this.boss.start();
    await this.boss.createQueue(QUEUE, {
      policy: "key_strict_fifo",
      warningQueueSize: 100,
    });
    if (!processJobs) return;
    await this.boss.work<WorkflowPayload>(
      QUEUE,
      {
        batchSize: 1,
        localConcurrency: workerConcurrency(),
        pollingIntervalSeconds: 2,
      },
      async (jobs) => {
        for (const job of jobs) await this.process(job.data);
      },
    );
  }

  async enqueue(
    userId: string,
    type: WorkflowType,
    options: { resourceId?: string; reserveBetaBatch?: boolean } = {},
  ) {
    const existing = await this.pool.query<WorkflowRunRow>(
      `select id, type, status, error, created_at, started_at, completed_at,
              cancellation_requested_at
       from rolegain_workflow_runs
       where user_id = $1
         and type = $2
         and coalesce(resource_key, '') = coalesce($3, '')
         and status in ('queued', 'running')
         and cancellation_requested_at is null
       order by created_at desc
       limit 1`,
      [userId, type, options.resourceId],
    );
    if (existing.rows[0] && workflowBlocksEnqueue(existing.rows[0]))
      return asWorkflowRun(existing.rows[0]);
    const reservesBetaBatch =
      isApplicationBatch(type) && options.reserveBetaBatch !== false;
    if (reservesBetaBatch) await this.platform.reserveBatch(userId);
    else {
      await this.platform.assertCodexEnabled();
      await this.platform.assertLlmAllowance(userId);
    }
    const runId = randomUUID();
    try {
      await this.pool.query(
        `insert into rolegain_workflow_runs
           (id, user_id, type, resource_key, status)
         values ($1, $2, $3, $4, 'queued')`,
        [runId, userId, type, options.resourceId],
      );
      const queueJobId = await this.boss.send(
        QUEUE,
        {
          runId,
          userId,
          type,
          resourceId: options.resourceId,
        } satisfies WorkflowPayload,
        {
          singletonKey: userId,
          retryLimit: 2,
          retryDelay: 15,
          retryBackoff: true,
          expireInSeconds: 60 * 60,
        },
      );
      if (!queueJobId)
        throw new Error("The workflow could not be added to the queue");
      await this.pool.query(
        "update rolegain_workflow_runs set queue_job_id = $2 where id = $1",
        [runId, queueJobId],
      );
      await this.platform.recordEvent(userId, {
        name: "workflow_started",
        metadata: { type },
      });
      return (await this.byId(runId))!;
    } catch (error) {
      if (reservesBetaBatch)
        await this.platform.releaseBatch(userId).catch(() => undefined);
      throw error;
    }
  }

  async latest(userId: string) {
    const result = await this.pool.query<WorkflowRunRow>(
      `select id, type, status, error, created_at, started_at, completed_at,
              cancellation_requested_at
       from rolegain_workflow_runs
       where user_id = $1
       order by created_at desc
       limit 1`,
      [userId],
    );
    return result.rows[0] ? asWorkflowRun(result.rows[0]) : undefined;
  }

  async cancel(userId: string) {
    const result = await this.pool.query<{ id: string; queue_job_id: string | null }>(
      `update rolegain_workflow_runs
       set cancellation_requested_at = now(),
           status = case when status = 'queued' then 'cancelled' else status end,
           completed_at = case when status = 'queued' then now() else completed_at end
       where user_id = $1 and status in ('queued', 'running')
       returning id, queue_job_id`,
      [userId],
    );
    for (const row of result.rows)
      if (row.queue_job_id)
        await this.boss.cancel(QUEUE, row.queue_job_id).catch(() => undefined);
    await Promise.all([
      this.service.stopBackgroundWork(userId),
      this.codex.pauseTurnsForUser(userId),
    ]);
  }

  close() {
    return this.boss.stop({ graceful: true, timeout: 30_000 });
  }

  private async process(payload: WorkflowPayload) {
    await withUserLock(this.lockPool, payload.userId, async () => {
      const state = await this.pool.query<{ cancellation_requested_at: Date | null }>(
        `update rolegain_workflow_runs
         set status = 'running', started_at = coalesce(started_at, now()), error = null
         where id = $1 and status <> 'cancelled'
         returning cancellation_requested_at`,
        [payload.runId],
      );
      if (!state.rows[0] || state.rows[0].cancellation_requested_at) return;
      try {
        await this.platform.assertCodexEnabled();
        await this.platform.assertLlmAllowance(payload.userId);
        await this.artifacts.restore(payload.userId);
        await this.codex.runWithExecutionContext(
          { userId: payload.userId, workflowRunId: payload.runId },
          () => this.execute(payload),
        );
        const workspace = await this.service.get(payload.userId);
        await this.platform.recordApplications(
          payload.userId,
          workspace.applications
            .filter((application) => Boolean(application.addedBy))
            .map((application) => application.id),
        );
        await this.artifacts.snapshot(payload.userId);
        await this.pool.query(
          `update rolegain_workflow_runs
           set status = 'completed', completed_at = now()
           where id = $1`,
          [payload.runId],
        );
        await this.platform.recordEvent(payload.userId, {
          name: "workflow_completed",
          metadata: { type: payload.type },
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        const cancellation = await this.pool.query<{
          cancellation_requested_at: Date | null;
        }>(
          "select cancellation_requested_at from rolegain_workflow_runs where id = $1",
          [payload.runId],
        );
        if (!cancellation.rows[0]?.cancellation_requested_at)
          await this.service
            .markWorkflowFailed(
              payload.type,
              message,
              payload.userId,
              payload.resourceId,
            )
            .catch(() => undefined);
        await this.pool.query(
          `update rolegain_workflow_runs
           set status = case when cancellation_requested_at is null then 'failed' else 'cancelled' end,
               error = $2,
               completed_at = now()
           where id = $1`,
          [
            payload.runId,
            message,
          ],
        );
        await this.platform.recordEvent(payload.userId, {
          name: "workflow_failed",
          metadata: { type: payload.type },
        }).catch(() => undefined);
        throw error;
      }
    });
  }

  private async execute(payload: WorkflowPayload) {
    const beta = await this.platform.betaStatus(payload.userId);
    const applicationTarget = Math.min(
      BETA_BATCH_SIZE,
      beta.remainingApplications,
    );
    switch (payload.type) {
      case "analyze": {
        const workspace = await this.service.analyzeCandidate(payload.userId);
        if (workspace.intelligence.status !== "ready")
          throw new Error(
            workspace.intelligence.error ||
              "Candidate analysis did not reach a ready state",
          );
        return;
      }
      case "prepare":
        if (applicationTarget <= 0) throw betaApplicationsExhausted();
        await this.service.prepareApplications(
          payload.userId,
          applicationTarget,
        );
        return;
      case "prepare-search-ready":
        if (applicationTarget <= 0) throw betaApplicationsExhausted();
        await this.service.prepareSearchReadyApplications(
          payload.userId,
          applicationTarget,
        );
        return;
      case "find-more":
        if (applicationTarget <= 0) throw betaApplicationsExhausted();
        await this.service.findMoreApplications(
          payload.userId,
          applicationTarget,
        );
        return;
      case "tailor-cv":
        if (!payload.resourceId)
          throw new Error("Tailored CV workflow is missing an application id");
        await this.service.tailorApplicationCv(
          payload.resourceId,
          payload.userId,
        );
    }
  }

  private async byId(id: string) {
    const result = await this.pool.query<WorkflowRunRow>(
      `select id, type, status, error, created_at, started_at, completed_at,
              cancellation_requested_at
       from rolegain_workflow_runs where id = $1`,
      [id],
    );
    return result.rows[0] ? asWorkflowRun(result.rows[0]) : undefined;
  }
}

function isApplicationBatch(type: WorkflowType) {
  return (
    type === "prepare" ||
    type === "prepare-search-ready" ||
    type === "find-more"
  );
}

function betaApplicationsExhausted() {
  return new Error("The beta application allowance has been completed");
}

interface WorkflowRunRow {
  id: string;
  type: WorkflowType;
  status: WorkflowRun["status"];
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  cancellation_requested_at: Date | null;
}

function asWorkflowRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    error: row.error || undefined,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString(),
    completedAt: row.completed_at?.toISOString(),
    cancellationRequestedAt: row.cancellation_requested_at?.toISOString(),
  };
}

export function workflowBlocksEnqueue(
  run:
    | {
        status: WorkflowRun["status"];
        cancellation_requested_at?: Date | null;
      }
    | undefined,
) {
  return Boolean(
    run &&
      (run.status === "queued" || run.status === "running") &&
      !run.cancellation_requested_at,
  );
}

export function workflowQueuePoolSize(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return positiveInteger(
    environment.ROLEGAIN_WORKFLOW_QUEUE_POOL_SIZE,
    DEFAULT_WORKFLOW_QUEUE_POOL_SIZE,
  );
}

export function workerConcurrency(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return positiveInteger(
    environment.ROLEGAIN_WORKER_CONCURRENCY,
    DEFAULT_WORKER_CONCURRENCY,
  );
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
