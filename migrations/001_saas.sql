create table if not exists rolegain_workspaces (
  user_id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists rolegain_workflow_runs (
  id uuid primary key,
  user_id text not null,
  type text not null,
  resource_key text,
  status text not null check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  progress jsonb,
  error text,
  cancellation_requested_at timestamptz,
  queue_job_id text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create index if not exists rolegain_workflow_runs_user_created_idx
  on rolegain_workflow_runs (user_id, created_at desc);

alter table rolegain_workflow_runs
  add column if not exists queue_job_id text;

alter table rolegain_workflow_runs
  add column if not exists resource_key text;

create index if not exists rolegain_workflow_runs_active_resource_idx
  on rolegain_workflow_runs (user_id, type, resource_key, created_at desc);

create table if not exists rolegain_user_token_usage (
  user_id text primary key,
  total_tokens bigint not null default 0 check (total_tokens >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists rolegain_token_usage_receipts (
  idempotency_key text primary key,
  user_id text not null,
  tokens bigint not null check (tokens >= 0),
  created_at timestamptz not null default now()
);

create table if not exists rolegain_beta_usage (
  user_id text primary key,
  batches_started integer not null default 0
    check (batches_started >= 0),
  application_limit integer not null default 10
    check (application_limit >= 0),
  release_updates boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table rolegain_beta_usage
  add column if not exists application_limit integer not null default 10;

alter table rolegain_beta_usage
  drop constraint if exists rolegain_beta_usage_batches_started_check;

alter table rolegain_beta_usage
  add constraint rolegain_beta_usage_batches_started_check
  check (batches_started >= 0);

alter table rolegain_beta_usage
  drop constraint if exists rolegain_beta_usage_application_limit_check;

alter table rolegain_beta_usage
  add constraint rolegain_beta_usage_application_limit_check
  check (application_limit >= 0);

create table if not exists rolegain_beta_applications (
  user_id text not null,
  application_id text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, application_id)
);

create index if not exists rolegain_beta_applications_user_created_idx
  on rolegain_beta_applications (user_id, created_at desc);

create table if not exists rolegain_analytics_events (
  id bigserial primary key,
  user_id text not null,
  event_name text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists rolegain_analytics_events_user_created_idx
  on rolegain_analytics_events (user_id, created_at desc);

create index if not exists rolegain_analytics_events_name_created_idx
  on rolegain_analytics_events (event_name, created_at desc);

create table if not exists rolegain_system_settings (
  setting_key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- These tables are backend-only. Supabase exposes public-schema tables through
-- PostgREST, so enable RLS without adding browser roles or policies. The
-- backend connects with the database owner/service credentials and remains the
-- only data-access boundary.
alter table rolegain_workspaces enable row level security;
alter table rolegain_workflow_runs enable row level security;
alter table rolegain_user_token_usage enable row level security;
alter table rolegain_token_usage_receipts enable row level security;
alter table rolegain_beta_usage enable row level security;
alter table rolegain_beta_applications enable row level security;
alter table rolegain_analytics_events enable row level security;
alter table rolegain_system_settings enable row level security;
