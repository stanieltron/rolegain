import type { Pool } from "pg";
import type { JobSearchWorkspace } from "../../contracts/job-search.js";
import { HttpError } from "../../server/auth.js";

export const BETA_APPLICATION_LIMIT = 10;
export const BETA_BATCH_SIZE = 5;

export interface BetaStatus {
  applicationsUsed: number;
  applicationLimit: number;
  batchesStarted: number;
  batchLimit: number;
  remainingApplications: number;
  remainingBatches: number;
  canStartBatch: boolean;
  releaseUpdates: boolean;
}

export interface ServiceStatus {
  codexEnabled: boolean;
  maintenanceMessage?: string;
}

export interface AnalyticsEvent {
  name: AnalyticsEventName;
  metadata?: Record<string, string | number | boolean | null>;
}

export type AnalyticsEventName =
  | "view_profile"
  | "view_discovery"
  | "view_applications"
  | "job_source_opened"
  | "application_opened"
  | "employer_form_opened"
  | "tailored_cv_requested"
  | "application_marked_applied"
  | "workflow_started"
  | "workflow_completed"
  | "workflow_failed"
  | "beta_release_updates_enabled";

const ANALYTICS_EVENTS = new Set<AnalyticsEventName>([
  "view_profile",
  "view_discovery",
  "view_applications",
  "job_source_opened",
  "application_opened",
  "employer_form_opened",
  "tailored_cv_requested",
  "application_marked_applied",
  "workflow_started",
  "workflow_completed",
  "workflow_failed",
  "beta_release_updates_enabled",
]);

interface MemoryBetaState {
  batchesStarted: number;
  applications: Set<string>;
  applicationLimit: number;
  releaseUpdates: boolean;
}

export interface AdminUserSummary {
  id: string;
  email?: string;
  name?: string;
  registeredAt?: string;
  lastSignInAt?: string;
  phase: string;
  profileCompleteness: number;
  sources: number;
  jobsSeen: number;
  searchReadyJobs: number;
  applications: number;
  applied: number;
  tokens: number;
  beta: BetaStatus;
  latestWorkflow?: {
    type: string;
    status: string;
    createdAt: string;
  };
  events: Record<string, number>;
  lastActiveAt?: string;
}

export interface AdminOverview {
  generatedAt: string;
  service: ServiceStatus;
  totals: {
    users: number;
    tokens: number;
    applications: number;
    jobSourceClicks: number;
  };
  eventTotals: Record<string, number>;
  users: AdminUserSummary[];
}

export class PlatformControl {
  private readonly memoryBeta = new Map<string, MemoryBetaState>();
  private readonly memoryEvents: Array<{
    userId: string;
    event: AnalyticsEvent;
    createdAt: string;
  }> = [];
  private memoryCodexEnabled = true;

  constructor(private readonly pool?: Pool) {}

  async serviceStatus(): Promise<ServiceStatus> {
    if (!this.pool)
      return {
        codexEnabled: this.memoryCodexEnabled,
        ...(!this.memoryCodexEnabled
          ? { maintenanceMessage: betaMaintenanceMessage() }
          : {}),
      };
    const result = await this.pool.query<{ value: boolean }>(
      `select coalesce((value #>> '{}')::boolean, true) as value
       from rolegain_system_settings
       where setting_key = 'codex_enabled'`,
    );
    const codexEnabled = result.rows[0]?.value ?? true;
    return {
      codexEnabled,
      ...(!codexEnabled
        ? { maintenanceMessage: betaMaintenanceMessage() }
        : {}),
    };
  }

  async setCodexEnabled(codexEnabled: boolean): Promise<ServiceStatus> {
    if (!this.pool) this.memoryCodexEnabled = codexEnabled;
    else
      await this.pool.query(
        `insert into rolegain_system_settings (setting_key, value, updated_at)
         values ('codex_enabled', $1::jsonb, now())
         on conflict (setting_key) do update
         set value = excluded.value, updated_at = now()`,
        [JSON.stringify(codexEnabled)],
      );
    return this.serviceStatus();
  }

  async assertCodexEnabled() {
    if (!(await this.serviceStatus()).codexEnabled)
      throw new HttpError(
        503,
        betaMaintenanceMessage(),
        "codex_maintenance",
      );
  }

  async betaStatus(userId: string): Promise<BetaStatus> {
    if (!this.pool) {
      const state = this.memoryState(userId);
      return betaStatusFrom(
        state.batchesStarted,
        state.applications.size,
        state.releaseUpdates,
        state.applicationLimit,
      );
    }
    const result = await this.pool.query<{
      batches_started: number;
      applications_used: string;
      release_updates: boolean;
      application_limit: number;
    }>(
      `select coalesce(usage.batches_started, 0) as batches_started,
              coalesce(apps.applications_used, 0) as applications_used,
              coalesce(usage.release_updates, false) as release_updates,
              coalesce(usage.application_limit, $2) as application_limit
       from (select $1::text as user_id) actor
       left join rolegain_beta_usage usage on usage.user_id = actor.user_id
       left join (
         select user_id, count(*) as applications_used
         from rolegain_beta_applications
         where user_id = $1
         group by user_id
       ) apps on apps.user_id = actor.user_id`,
      [userId, BETA_APPLICATION_LIMIT],
    );
    const row = result.rows[0];
    return betaStatusFrom(
      Number(row?.batches_started ?? 0),
      Number(row?.applications_used ?? 0),
      row?.release_updates ?? false,
      Number(row?.application_limit ?? BETA_APPLICATION_LIMIT),
    );
  }

  async reserveBatch(userId: string): Promise<BetaStatus> {
    await this.assertCodexEnabled();
    if (!this.pool) {
      const state = this.memoryState(userId);
      const status = betaStatusFrom(
        state.batchesStarted,
        state.applications.size,
        state.releaseUpdates,
        state.applicationLimit,
      );
      if (!status.canStartBatch) throw betaLimitError();
      state.batchesStarted += 1;
      return this.betaStatus(userId);
    }
    const result = await this.pool.query<{ batches_started: number }>(
      `insert into rolegain_beta_usage
         (user_id, batches_started, updated_at)
       select $1, 1, now()
       where (
         select count(*)
         from rolegain_beta_applications
         where user_id = $1
       ) < $3
       on conflict (user_id) do update
       set batches_started = rolegain_beta_usage.batches_started + 1,
           updated_at = now()
       where rolegain_beta_usage.batches_started <
             ceil(rolegain_beta_usage.application_limit::numeric / $2)
         and (
           select count(*)
           from rolegain_beta_applications
           where user_id = $1
         ) < rolegain_beta_usage.application_limit
       returning batches_started`,
      [userId, BETA_BATCH_SIZE, BETA_APPLICATION_LIMIT],
    );
    if (!result.rows[0]) throw betaLimitError();
    return this.betaStatus(userId);
  }

  async releaseBatch(userId: string) {
    if (!this.pool) {
      const state = this.memoryState(userId);
      state.batchesStarted = Math.max(0, state.batchesStarted - 1);
      return;
    }
    await this.pool.query(
      `update rolegain_beta_usage
       set batches_started = greatest(0, batches_started - 1),
           updated_at = now()
       where user_id = $1`,
      [userId],
    );
  }

  async assertApplicationAvailable(userId: string) {
    await this.assertCodexEnabled();
    if ((await this.betaStatus(userId)).remainingApplications <= 0)
      throw betaLimitError();
  }

  async assertLlmAllowance(userId: string) {
    if ((await this.betaStatus(userId)).remainingApplications <= 0)
      throw betaLimitError();
  }

  async recordApplications(userId: string, applicationIds: string[]) {
    const unique = [...new Set(applicationIds.filter(Boolean))];
    if (!unique.length) return this.betaStatus(userId);
    if (!this.pool) {
      const state = this.memoryState(userId);
      for (const id of unique)
        if (state.applications.size < state.applicationLimit)
          state.applications.add(id);
      return this.betaStatus(userId);
    }
    await this.pool.query(
      `insert into rolegain_beta_applications (user_id, application_id)
       select $1, application_id
       from unnest($2::text[]) as application_id
       on conflict (user_id, application_id) do nothing`,
      [userId, unique],
    );
    return this.betaStatus(userId);
  }

  async enableReleaseUpdates(userId: string) {
    if (!this.pool) this.memoryState(userId).releaseUpdates = true;
    else
      await this.pool.query(
        `insert into rolegain_beta_usage
           (user_id, release_updates, updated_at)
         values ($1, true, now())
         on conflict (user_id) do update
         set release_updates = true, updated_at = now()`,
        [userId],
      );
    await this.recordEvent(userId, {
      name: "beta_release_updates_enabled",
    });
    return this.betaStatus(userId);
  }

  async setUserApplicationLimit(userId: string, applicationLimit: number) {
    if (
      !Number.isSafeInteger(applicationLimit) ||
      applicationLimit < 0 ||
      applicationLimit > 10_000
    )
      throw new HttpError(
        400,
        "Application limit must be a whole number between 0 and 10,000",
        "invalid_beta_limit",
      );
    const current = await this.betaStatus(userId);
    if (applicationLimit < current.applicationsUsed)
      throw new HttpError(
        409,
        `Application limit cannot be lower than the ${current.applicationsUsed} applications already used`,
        "beta_limit_below_usage",
      );
    if (!this.pool) this.memoryState(userId).applicationLimit = applicationLimit;
    else
      await this.pool.query(
        `insert into rolegain_beta_usage
           (user_id, application_limit, updated_at)
         values ($1, $2, now())
         on conflict (user_id) do update
         set application_limit = excluded.application_limit,
             updated_at = now()`,
        [userId, applicationLimit],
      );
    return this.betaStatus(userId);
  }

  async recordEvent(userId: string, event: AnalyticsEvent) {
    if (!ANALYTICS_EVENTS.has(event.name))
      throw new HttpError(400, "Unknown analytics event", "invalid_event");
    const metadata = cleanMetadata(event.metadata);
    if (!this.pool) {
      this.memoryEvents.push({
        userId,
        event: { name: event.name, metadata },
        createdAt: new Date().toISOString(),
      });
      return;
    }
    await this.pool.query(
      `insert into rolegain_analytics_events
         (user_id, event_name, metadata)
       values ($1, $2, $3::jsonb)`,
      [userId, event.name, JSON.stringify(metadata)],
    );
  }

  async adminOverview(): Promise<AdminOverview> {
    const service = await this.serviceStatus();
    if (!this.pool) {
      const users = [...this.memoryBeta.keys()].map((id) => ({
        id,
        phase: "local",
        profileCompleteness: 0,
        sources: 0,
        jobsSeen: 0,
        searchReadyJobs: 0,
        applications: this.memoryState(id).applications.size,
        applied: 0,
        tokens: 0,
        beta: betaStatusFrom(
          this.memoryState(id).batchesStarted,
          this.memoryState(id).applications.size,
          this.memoryState(id).releaseUpdates,
          this.memoryState(id).applicationLimit,
        ),
        events: eventCounts(
          this.memoryEvents
            .filter((event) => event.userId === id)
            .map((event) => event.event.name),
        ),
      }));
      return overviewFrom(service, users);
    }

    const [authRows, workspaces, tokens, betaRows, workflows, events] =
      await Promise.all([
        this.pool.query<{
          id: string;
          email: string | null;
          name: string | null;
          created_at: Date;
          last_sign_in_at: Date | null;
        }>(
          `select id::text, email,
                  coalesce(raw_user_meta_data->>'full_name',
                           raw_user_meta_data->>'name') as name,
                  created_at, last_sign_in_at
           from auth.users
           order by created_at desc`,
        ),
        this.pool.query<{ user_id: string; payload: JobSearchWorkspace }>(
          "select user_id, payload from rolegain_workspaces",
        ),
        this.pool.query<{ user_id: string; total_tokens: string }>(
          "select user_id, total_tokens from rolegain_user_token_usage",
        ),
        this.pool.query<{
          user_id: string;
          batches_started: number;
          release_updates: boolean;
          applications_used: string;
          application_limit: number;
        }>(
          `select usage.user_id, usage.batches_started, usage.release_updates,
                  usage.application_limit,
                  count(apps.application_id) as applications_used
           from rolegain_beta_usage usage
           left join rolegain_beta_applications apps
             on apps.user_id = usage.user_id
           group by usage.user_id, usage.batches_started,
                    usage.release_updates, usage.application_limit`,
        ),
        this.pool.query<{
          user_id: string;
          type: string;
          status: string;
          created_at: Date;
        }>(
          `select distinct on (user_id)
                  user_id, type, status, created_at
           from rolegain_workflow_runs
           order by user_id, created_at desc`,
        ),
        this.pool.query<{
          user_id: string;
          event_name: string;
          count: string;
          last_at: Date;
        }>(
          `select user_id, event_name, count(*) as count, max(created_at) as last_at
           from rolegain_analytics_events
           group by user_id, event_name`,
        ),
      ]);

    const usersById = new Map<string, AdminUserSummary>();
    const ensure = (id: string) => {
      let user = usersById.get(id);
      if (!user) {
        user = {
          id,
          phase: "registered",
          profileCompleteness: 0,
          sources: 0,
          jobsSeen: 0,
          searchReadyJobs: 0,
          applications: 0,
          applied: 0,
          tokens: 0,
          beta: betaStatusFrom(0, 0, false, BETA_APPLICATION_LIMIT),
          events: {},
        };
        usersById.set(id, user);
      }
      return user;
    };

    for (const row of authRows.rows) {
      const user = ensure(row.id);
      user.email = row.email || undefined;
      user.name = row.name || undefined;
      user.registeredAt = row.created_at.toISOString();
      user.lastSignInAt = row.last_sign_in_at?.toISOString();
    }
    for (const row of workspaces.rows) {
      const user = ensure(row.user_id);
      const workspace = row.payload;
      user.name ||= workspace.profile?.name;
      user.email ||= workspace.profile?.email;
      user.phase = workspace.phase ?? "registered";
      user.profileCompleteness = workspace.profileCompleteness ?? 0;
      user.sources = workspace.sources?.length ?? 0;
      user.jobsSeen = workspace.jobHistory?.length ?? 0;
      user.searchReadyJobs = workspace.searchReadyOpportunities?.length ?? 0;
      user.applications = workspace.applications?.length ?? 0;
      user.applied =
        workspace.applications?.filter(
          (application) => application.outcome === "applied_waiting",
        ).length ?? 0;
    }
    for (const row of tokens.rows)
      ensure(row.user_id).tokens = Number(row.total_tokens);
    for (const row of betaRows.rows)
      ensure(row.user_id).beta = betaStatusFrom(
        row.batches_started,
        Number(row.applications_used),
        row.release_updates,
        row.application_limit,
      );
    for (const row of workflows.rows)
      ensure(row.user_id).latestWorkflow = {
        type: row.type,
        status: row.status,
        createdAt: row.created_at.toISOString(),
      };
    for (const row of events.rows) {
      const user = ensure(row.user_id);
      user.events[row.event_name] = Number(row.count);
      if (!user.lastActiveAt || row.last_at.toISOString() > user.lastActiveAt)
        user.lastActiveAt = row.last_at.toISOString();
    }
    const users = [...usersById.values()].sort((left, right) =>
      (right.lastActiveAt || right.registeredAt || "").localeCompare(
        left.lastActiveAt || left.registeredAt || "",
      ),
    );
    return overviewFrom(service, users);
  }

  private memoryState(userId: string) {
    let state = this.memoryBeta.get(userId);
    if (!state) {
      state = {
        batchesStarted: 0,
        applications: new Set(),
        applicationLimit: BETA_APPLICATION_LIMIT,
        releaseUpdates: false,
      };
      this.memoryBeta.set(userId, state);
    }
    return state;
  }
}

function betaStatusFrom(
  batchesStarted: number,
  applicationsUsed: number,
  releaseUpdates: boolean,
  applicationLimit = BETA_APPLICATION_LIMIT,
): BetaStatus {
  const limit = Math.max(0, applicationLimit);
  const batchLimit = Math.ceil(limit / BETA_BATCH_SIZE);
  const used = Math.max(0, applicationsUsed);
  const batches = Math.max(0, batchesStarted);
  return {
    applicationsUsed: used,
    applicationLimit: limit,
    batchesStarted: batches,
    batchLimit,
    remainingApplications: Math.max(0, limit - used),
    remainingBatches: Math.max(0, batchLimit - batches),
    canStartBatch:
      batches < batchLimit && used < limit,
    releaseUpdates,
  };
}

function betaLimitError() {
  return new HttpError(
    403,
    "You have completed the Rolegain beta allowance. This beta includes two batches of up to five applications. Keep release updates enabled and we will let you know when more access is available.",
    "beta_limit_reached",
  );
}

function betaMaintenanceMessage() {
  return "Rolegain is temporarily paused while we maintain the beta. Your existing profile and applications remain safe. Please try again shortly.";
}

function cleanMetadata(
  metadata: AnalyticsEvent["metadata"] = {},
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(metadata)
      .slice(0, 12)
      .map(([key, value]) => [
        key.slice(0, 64),
        typeof value === "string" ? value.slice(0, 300) : value,
      ])
      .filter(([, value]) =>
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ),
  ) as Record<string, string | number | boolean | null>;
}

function eventCounts(names: string[]) {
  return names.reduce<Record<string, number>>((counts, name) => {
    counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  }, {});
}

function overviewFrom(
  service: ServiceStatus,
  users: AdminUserSummary[],
): AdminOverview {
  const eventTotals: Record<string, number> = {};
  for (const user of users)
    for (const [event, count] of Object.entries(user.events))
      eventTotals[event] = (eventTotals[event] ?? 0) + count;
  return {
    generatedAt: new Date().toISOString(),
    service,
    totals: {
      users: users.length,
      tokens: users.reduce((total, user) => total + user.tokens, 0),
      applications: users.reduce(
        (total, user) => total + user.beta.applicationsUsed,
        0,
      ),
      jobSourceClicks: eventTotals.job_source_opened ?? 0,
    },
    eventTotals,
    users,
  };
}
