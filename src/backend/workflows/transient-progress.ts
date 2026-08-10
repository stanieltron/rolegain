import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

const CHANNEL = "rolegain_workflow_progress";

export interface TransientWorkflowProgressEvent {
  id: string;
  userId: string;
  createdAt: string;
  message: string;
  phase?: "validation" | "match" | "application" | "application_verification";
  state?: "waiting" | "running" | "passed" | "failed" | "bench" | "selected";
  jobId?: string;
  jobNumber?: number;
  company?: string;
  title?: string;
  fit?: number;
}

export type TransientWorkflowProgressInput = Omit<
  TransientWorkflowProgressEvent,
  "id" | "createdAt" | "userId"
>;

export interface TransientWorkflowProgressBus {
  publish(userId: string, event: TransientWorkflowProgressInput): Promise<void>;
  subscribe(
    userId: string,
    listener: (event: TransientWorkflowProgressEvent) => void,
  ): Promise<() => void>;
  close(): Promise<void>;
}

export class InMemoryTransientWorkflowProgressBus
  implements TransientWorkflowProgressBus
{
  private readonly listeners = new Map<
    string,
    Set<(event: TransientWorkflowProgressEvent) => void>
  >();

  async publish(userId: string, input: TransientWorkflowProgressInput) {
    const event = progressEvent(userId, input);
    for (const listener of this.listeners.get(userId) ?? []) listener(event);
  }

  async subscribe(
    userId: string,
    listener: (event: TransientWorkflowProgressEvent) => void,
  ) {
    const listeners = this.listeners.get(userId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(userId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(userId);
    };
  }

  async close() {
    this.listeners.clear();
  }
}

/** PostgreSQL NOTIFY crosses the Railway web/worker boundary without storing events. */
export class PostgresTransientWorkflowProgressBus
  implements TransientWorkflowProgressBus
{
  private readonly listeners = new Map<
    string,
    Set<(event: TransientWorkflowProgressEvent) => void>
  >();
  private client?: PoolClient;
  private connecting?: Promise<void>;
  private closed = false;

  constructor(
    private readonly publishPool: Pool,
    private readonly listenPool: Pool,
  ) {}

  async publish(userId: string, input: TransientWorkflowProgressInput) {
    const payload = JSON.stringify(progressEvent(userId, input));
    await this.publishPool.query("select pg_notify($1, $2)", [CHANNEL, payload]);
  }

  async subscribe(
    userId: string,
    listener: (event: TransientWorkflowProgressEvent) => void,
  ) {
    const listeners = this.listeners.get(userId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(userId, listeners);
    await this.ensureListening();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(userId);
    };
  }

  async close() {
    this.closed = true;
    this.listeners.clear();
    const client = this.client;
    this.client = undefined;
    if (client) {
      await client.query(`unlisten ${CHANNEL}`).catch(() => undefined);
      client.release();
    }
  }

  private async ensureListening() {
    if (this.client || this.closed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect()
      .catch((error) => {
        console.error("Transient workflow progress listener failed", error);
        throw error;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  private async connect() {
    const client = await this.listenPool.connect();
    this.client = client;
    client.on("notification", (notification) => {
      if (notification.channel !== CHANNEL || !notification.payload) return;
      try {
        const event = JSON.parse(notification.payload) as TransientWorkflowProgressEvent;
        for (const listener of this.listeners.get(event.userId) ?? []) listener(event);
      } catch {
        // Ignore malformed ephemeral messages; durable workflow state is unaffected.
      }
    });
    client.on("error", (error) => {
      console.error("Transient workflow progress connection error", error);
      if (this.client === client) this.client = undefined;
      client.release(true);
      if (!this.closed && this.listeners.size > 0)
        setTimeout(() => void this.ensureListening().catch(() => undefined), 1_000);
    });
    await client.query(`listen ${CHANNEL}`);
  }
}

function progressEvent(
  userId: string,
  input: TransientWorkflowProgressInput,
): TransientWorkflowProgressEvent {
  return {
    id: randomUUID(),
    userId,
    createdAt: new Date().toISOString(),
    ...input,
    message: input.message.slice(0, 2_000),
  };
}
