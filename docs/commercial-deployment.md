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
7. Configure the LLM provider API key, base URL, model and provider-specific web
   search request body.

Google login does not require Gmail permissions. Do not request Gmail scopes;
Rolegain only needs identity, email and profile.

## Environment

Start from `.env.example`. In commercial mode the important values are:

```dotenv
ROLEGAIN_AUTH_MODE=supabase
ROLEGAIN_PUBLIC_ORIGIN=https://app.example.com
ROLEGAIN_OBJECT_STORAGE=enabled

DATABASE_URL=postgresql://...
SUPABASE_URL=https://....supabase.co
SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_STORAGE_BUCKET=rolegain-private

VITE_ROLEGAIN_AUTH_MODE=supabase
VITE_SUPABASE_URL=https://....supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=...

ROLEGAIN_LLM_TRANSPORT=api
ROLEGAIN_API_KEY=...
ROLEGAIN_API_BASE_URL=...
ROLEGAIN_API_MODEL=...
ROLEGAIN_API_WEB_SEARCH_BODY=...
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

Run one or more worker instances:

```powershell
npm run start:worker:production
```

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

The supplied `Dockerfile` builds the Vite frontend, compiles the TypeScript
server, installs Chromium, and starts the web process. Use the same image for a
worker by overriding the command:

```text
node dist/server/scripts/start-worker.js
```

The web service must expose port `4317`. Set its health check to `/api/health`.

## Token counter

Every LLM completion is attributed to the authenticated execution context.
Rolegain accepts the common `total_tokens` variants, falling back to
input/prompt plus output/completion tokens. A deduplication receipt prevents a
completion callback from incrementing the same user twice.

Users can read their current total from `GET /api/usage`; the authenticated UI
shows the counter in its header.
