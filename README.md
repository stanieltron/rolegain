# RolegAIn

RolegAIn is an evidence-backed job search and application system powered by
isolated LLM calls through either Codex CLI or an OpenAI-compatible API. The
repository is organized as composable pipelines:
each one accepts a documented input, produces a documented output, and can be
run alone or composed by the backend control flow.

## Repository map

```text
src/
|-- 01-evidence-ingestion/       # evidence sources -> canonical evidence
|   |-- 01-evidence-acquisition/ # deterministic
|   |-- 03-synthesis/            # LLM; owns its llm-calls/
|   |-- 04-verification/         # canonical ledger + evidence knowledge base
|   |-- v1/                      # reader + coverage + repair; complete contracts/schemas
|   |-- v2/                      # lean reader; complete contracts/schemas
|   `-- evidence-ingestion.ts    # top-level executable facade
|-- 02-search/                   # evidence -> validated live jobs
|   |-- v1/                      # adaptive discovery + verification package
|   `-- v2/                      # independent capture-first package
|-- 03-match/                    # validated jobs -> matched jobs and mapped forms
|   |-- v1/                      # verified multi-call matcher package
|   |-- v2/                      # calibrated one-pass matcher package
|   |-- shared/                  # deterministic matching mechanics and call programs
|   |-- 02-application-inspection/ # hybrid
|   |-- orchestration/           # bounded streaming composition
|   `-- opportunity-researcher.ts      # product facade composing search and match
|-- 04-application-preparation/  # selected jobs -> verified drafts
|   |-- 01-context/              # deterministic
|   |-- 02-draft/                # LLM
|   |-- 03-verification/         # hybrid
|   |-- 04-repair/               # LLM
|   |-- 05-refinement/           # LLM
|   `-- application-preparation.ts # top-level executable facade
|-- backend/control-flow/        # composition, persistence, sequencing, artifacts
|-- server/                      # HTTP transport and employer proxy
|-- ui/                          # React user interface
|-- contracts/                   # shared persisted data contracts
|-- codex-runtime/               # isolated model process runtime
|-- api-runtime/                 # OpenAI-compatible model transport
|-- llm-runtime/                 # process-level transport selection
`-- infrastructure/              # shared technical utilities and safety boundaries
```

Open a pipeline's `README.md` and named top-level executable first:
`evidence-ingestion.ts`, `opportunity-researcher.ts`, or
`application-preparation.ts`. Every numbered directory is a stage or an
explicit branch at that number. An LLM or hybrid stage owns its
`llm-calls/` directory, so its prompt, input, output schema, tool policy, memory
policy, and command are next to the code that invokes it. Evidence-ingestion
stage discovery comes from its numbered directories and the runnable stage
registry, not from duplicate TypeScript flow manifests.

The dependency direction is:

```text
UI -> server -> backend/control-flow -> pipelines -> runtime/infrastructure
                                      |
                                      `-> shared contracts
```

Pipelines never import UI, server, or backend orchestration. The architecture
test enforces that boundary and checks every model call against its owning
`llm-calls/` directory and the central LLM call catalog.

Each verified evidence run also publishes a compact `knowledge/` tree with an
overview, routing index, capability topics, and deep source pages. Matching
uses that tree to find relevant canonical claims for broad requirements, but
only exact canonical citations can affect the final score.

## Run

```powershell
npm install
npm run build
npm start
```

Open `http://127.0.0.1:4317`.

For authenticated commercial deployment, PostgreSQL-backed workflows, private
artifact storage and per-user token tracking, see
[Commercial deployment](./docs/commercial-deployment.md).

For development, run `npm run dev`. This starts the API on port 4317 and the UI
on port 5173 using Codex CLI.

Run the complete benchmark-selected v2 stack with:

```powershell
npm run dev:v2
# or, without the Vite UI:
npm run start:v2
```

These commands enable evidence ingestion v2, search v2, and matching v2 in the
same process. V1 remains the default for `npm run dev` and `npm start`. For
component-level experiments, set `ROLEGAIN_EVIDENCE_VERSION`,
`ROLEGAIN_SEARCH_VERSION`, or `ROLEGAIN_MATCH_VERSION` independently instead.

Each pipeline version has the same public package surface: `index.ts`,
`contracts.ts`, `schemas.ts`, and `README.md`. Version-specific eval commands
include `npm run eval:evidence:v1`, `npm run eval:evidence:v2`,
`npm run eval:match-requirements:v1`, and
`npm run eval:match-requirements:v2`.

To run the same flows through an OpenAI-compatible Chat Completions API:

```powershell
npm run dev:api
```

Use `npm run dev:api:v2` for the same API transport with evidence, search, and
matching v2 enabled together.

`dev:api` loads the gitignored `.env`; copy provider values from
`.env.example` and replace `ROLEGAIN_API_KEY`. `ROLEGAIN_API_BASE_URL` must be
the provider's OpenAI-compatible base URL, and `ROLEGAIN_API_MODEL` is the
provider model used for every call. Call-specific roles, skills, task builders,
schemas, reasoning efforts, verification, repair, and result gateways are
unchanged.

Providers differ around optional extensions. Set
`ROLEGAIN_API_OMIT_REASONING_EFFORT=true` if the endpoint rejects that field.
Calls requiring current public-web data use Gemini's native Google Search
endpoint and the same `ROLEGAIN_API_KEY`, then run a schema-bound synthesis
pass. `ROLEGAIN_GEMINI_BASE_URL` defaults to the public Gemini API and
`ROLEGAIN_GEMINI_SEARCH_MODEL` defaults to `ROLEGAIN_API_MODEL`. All other calls
use supplied context and need no provider tools.

## Run individual stages

List all runnable stages:

```powershell
npm run stage:list
```

Run one stage with mock input, the previous stage's artifact, or an explicit
JSON artifact:

```powershell
npm run stage -- evidence.acquire-source --input mock
npm run stage -- search.validate-vacancies --input previous
npm run stage -- match.requirements --input C:\path\to\input.json
```

Run whole evidence ingestion from a real CV, repository, or webpage, or inspect
one of its fan-out boundaries:

```powershell
npm run stage -- evidence.ingest --input C:\path\to\cv.pdf --artifacts C:\path\to\artifacts
npm run stage -- evidence.ingest --input https://github.com/owner/repository --artifacts C:\path\to\artifacts
npm run stage -- evidence.prepare-chunks --input C:\path\to\acquisition-output.json --artifacts C:\path\to\artifacts
npm run stage -- evidence.read-chunk --input C:\path\to\prepared-chunks.json --target 1 --artifacts C:\path\to\artifacts
```

Run the next two complete pipelines with the published handoff from the prior
pipeline:

```powershell
npm run stage -- search.run --input C:\path\to\evidence-artifacts\01-evidence-ingestion\stage-output.json --target 20 --artifacts C:\path\to\search-artifacts
npm run stage -- match.requirements --input C:\path\to\search-artifacts\02-search\stage-output.json --artifacts C:\path\to\match-artifacts
npm run stage -- applications.inspect-form --input C:\path\to\match-artifacts\03-match\01-requirement-matching\stage-output.json --artifacts C:\path\to\match-artifacts
npm run stage -- applications.prepare --input C:\path\to\match-artifacts\03-match\02-application-inspection\stage-output.json --artifacts C:\path\to\application-artifacts
```

See [the evidence-ingestion pipeline guide](./src/01-evidence-ingestion/README.md)
for native stage contracts, inspectable CLI artifacts, and raw reader/coverage
commands.
See also [Search](./src/02-search/README.md), [Match](./src/03-match/README.md),
and [Application Preparation](./src/04-application-preparation/README.md) for their
complete SVG flows and stage/substep commands.

Every stage writes an inspectable JSON input/output artifact. The artifact
envelope records its kind, schema version, producing pipeline, program, stage,
workspace reference, data, and runtime diagnostics.

## Verification

```powershell
npm test
npm run build
npm run test:evidence:steps
```

See [docs/architecture.md](./docs/architecture.md) for ownership rules and the
complete composed flow.
