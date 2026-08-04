# Commercial deployment

Rolegain keeps its existing React UI and pipeline code. Commercial mode adds:

- Supabase Google and email/password authentication;
- one isolated workspace per authenticated Supabase user;
- PostgreSQL workspace and workflow persistence;
- a durable PostgreSQL job queue with per-user serialization;
- private Supabase Storage artifact archives;
- a single durable total-token counter per user;
- automatic sourced company research only for jobs that reach Applications;
- user-triggered per-application CV tailoring with downloadable DOCX output;
- separate web and worker processes.
- closed-beta application limits, interaction analytics and a private admin
  control room at `/admin`.

## Required services

1. Create a Supabase project in the desired region.
2. Copy its project URL, publishable key, service-role key and pooled PostgreSQL
   connection string.
3. In Supabase Authentication, enable Email and Google.
4. In Google Cloud, create a Web OAuth client. Add the Supabase callback shown
   on the Supabase Google provider page as an authorized redirect URI. Copy the
   Google client ID and client secret into that provider page.
5. Configure custom SMTP in Supabase for confirmation and password-reset email.
6. Create or allow Rolegain to create a private Storage bucket named
   `rolegain-private`.
7. Configure the Gemini API key, OpenAI-compatible base URL and model. Live
   discovery and company research reuse that key through Gemini's native Google
   Search endpoint.
8. Optional: create a Resend API key for administrator workflow-failure alerts.

Google login does not require Gmail permissions. Do not request Gmail scopes;
Rolegain only needs identity, email and profile.

## Environment

Start from `.env.example`. In commercial mode the important values are:

```dotenv
ROLEGAIN_AUTH_MODE=supabase
ROLEGAIN_PUBLIC_ORIGIN=https://app.example.com
ROLEGAIN_OBJECT_STORAGE=enabled

# Choose all-v1 or all-v2 consistently across web and worker processes.
ROLEGAIN_EVIDENCE_VERSION=v2
ROLEGAIN_SEARCH_VERSION=v2
ROLEGAIN_MATCH_VERSION=v2

DATABASE_URL=postgresql://...
SUPABASE_URL=https://....supabase.co
SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_STORAGE_BUCKET=rolegain-private

ROLEGAIN_ADMIN_USERNAME=...
ROLEGAIN_ADMIN_PASSWORD=...
ROLEGAIN_ADMIN_SESSION_SECRET=... # at least 32 random characters

# Optional administrator workflow-failure alerts (worker service only).
RESEND_API_KEY=...
ROLEGAIN_ERROR_EMAIL_TO=admin@example.com
ROLEGAIN_ERROR_EMAIL_FROM=Rolegain alerts <onboarding@resend.dev>

VITE_ROLEGAIN_AUTH_MODE=supabase
VITE_SUPABASE_URL=https://....supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=...

ROLEGAIN_LLM_TRANSPORT=api
ROLEGAIN_API_KEY=...
ROLEGAIN_API_BASE_URL=...
ROLEGAIN_API_MODEL=...
ROLEGAIN_GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
# Optional; defaults to ROLEGAIN_API_MODEL
ROLEGAIN_GEMINI_SEARCH_MODEL=...
```

`VITE_*` values must be present while building the frontend. The Supabase
publishable key is intentionally public. Never expose the service-role key,
database URL or LLM key to the browser.

## Processes

Run the migration once:

```powershell
npm run db:migrate
```

Run one or more web instances without consuming jobs:

```powershell
$env:ROLEGAIN_PROCESS_JOBS="false"
npm run start:production
```

Use `npm run start:production:v2` instead to set all three pipeline versions to
v2 in that web process.

Run one or more worker instances:

```powershell
npm run start:worker:production
```

Use `npm run start:worker:production:v2` for the complete v2 worker. Web and
worker processes must use the same three version selections; a launcher cannot
change another process's environment.

Workers serialize jobs for the same user while allowing different users to run
concurrently. Configure provider-level concurrency conservatively before
increasing worker replicas.

Company research runs inside application preparation, after matching and form
inspection. It does not affect discovery or fit scoring. Set
`ROLEGAIN_COMPANY_RESEARCH_CONCURRENCY` to bound parallel public-web research
inside one application batch.

CV tailoring is an on-demand durable workflow in commercial mode. The generated
DOCX is stored with that user's private artifacts and becomes the CV selected by
the employer-form autofill path for that application. The original CV remains
the strict factual boundary and is not overwritten.

## Container

The supplied `Dockerfile` includes Codex and Chromium for the workflow worker.
Run that image as the worker by overriding its command:

```text
node dist/server/scripts/start-worker.js
```

The public web service should use `Dockerfile.web`, which builds the Vite
frontend and TypeScript server without installing the worker-only browser/AI
runtime.

The web service must expose port `4317`. Set its health check to `/api/health`.

## Token counter

Every LLM completion is attributed to the authenticated execution context.
Rolegain accepts the common `total_tokens` variants, falling back to
input/prompt plus output/completion tokens. A deduplication receipt prevents a
completion callback from incrementing the same user twice.

Users can read their current total from `GET /api/usage`; the authenticated UI
shows the counter in its header.

## Closed-beta controls

Every user starts with a total allowance of ten prepared applications split
across two batches of up to five. The allowance is stored separately from the
workspace, so resetting or deleting workspace data never restores LLM access.
When no allowance remains, all routes that can start LLM work and both reset
routes are blocked server-side.

Open `/admin` directly and sign in with the deployment-only administrator
credentials. The dashboard shows registered users, flow progress, job-link and
application interactions, workflow state and total tokens. An administrator
can set a higher total application limit for one user. Five more applications
unlock one additional batch.

The Disconnect Codex control persists a global maintenance switch in
PostgreSQL. The user UI changes to maintenance mode, new workflows are refused,
and the worker checks the switch before every new model turn.

## Railway Codex pilot worker

For a private pilot, the supplied image includes the pinned Codex CLI version.
Deploy the web and worker as separate Railway services from the same repository:

- web command: `node dist/server/src/server/index.js`;
- web variable: `ROLEGAIN_PROCESS_JOBS=false`;
- worker command: `node dist/server/scripts/start-worker.js`;
- worker variables: `ROLEGAIN_LLM_TRANSPORT=codex`,
  `ROLEGAIN_CODEX_HOME=/data/codex`,
  `ROLEGAIN_LLM_RUN_ROOT=/data/agent-runtime/runs`;
- optional worker alert variables: `RESEND_API_KEY`,
  `ROLEGAIN_ERROR_EMAIL_TO`, and `ROLEGAIN_ERROR_EMAIL_FROM`. Alerts contain a
  bounded, sanitized error summary and link to `/admin`; email failures never
  fail or delay the user workflow;
- ordinary application queries automatically use Supabase's shared transaction
  pooler on port 6543 when `DATABASE_URL` is a shared session-pooler URL on
  port 5432. `ROLEGAIN_TRANSACTION_DATABASE_URL` can override the derived URL;
- both services keep session mode only for pg-boss and advisory locks. Keep
  `ROLEGAIN_SESSION_POOL_SIZE=2`, `ROLEGAIN_WORKFLOW_QUEUE_POOL_SIZE=1`, and
  `ROLEGAIN_WORKER_CONCURRENCY=1` for a session pool limited to 15 clients.
  `ROLEGAIN_DATABASE_POOL_SIZE=5` controls transaction-pool clients and does
  not reserve five PostgreSQL backend sessions;
- mount a private persistent volume at `/data` on the worker;
- do not generate a public domain for the worker.

Both services use the same database and Supabase variables. Authenticate the
worker once from a Railway shell:

```text
node dist/server/scripts/login-codex.js --device-auth
```

Complete the displayed device-code flow in the browser. The resulting Codex
credentials remain in the private worker volume. This pilot mode is intended
for a small controlled beta; switch the worker to the API transport before
scaling it as a general public service.

Workflow Retry and Continue are scoped to the authenticated user. If a
`key_strict_fifo` job reaches pg-boss's terminal failed state, retrying the same
operation reactivates that job in place. Starting a different operation removes
only that user's stale terminal pg-boss record; the Rolegain workflow row stays
available as audit history. This prevents one failed job from permanently
blocking that user's queue without affecting other users.
