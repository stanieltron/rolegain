# Manual live-flow tests

This directory contains manually invoked tests that use the same production
dependency pipeline, Codex authentication, flow functions, web acquisition, and
persistence code as the HTTP/UI application.

They are intentionally excluded from `npm test`. They can make paid model
calls, access changing public webpages, take several minutes, and fail because
a vacancy was removed or an employer blocked automated access.

`mock` means **synthetic input to the selected stage**. It does not mean a
mocked Codex call. Every LLM boundary exercised by a live stage is real.

## Version selection

Live-stage commands use the same environment selectors as production and
default to v1. To exercise the complete v2 stack in a shell, export all three
before running the test:

```bash
export ROLEGAIN_EVIDENCE_VERSION=v2
export ROLEGAIN_SEARCH_VERSION=v2
export ROLEGAIN_MATCH_VERSION=v2
npm run test:live:flow -- --target 1
```

Set one selector alone only for a deliberate component comparison. The product
launchers `npm run dev:v2`, `npm run start:v2`, and
`npm run dev:diagnostic:v2` always enable all three together.

## Files to start from

| File | Purpose |
|---|---|
| `tests/live/README.md` | This operating guide |
| `scripts/inspect-live-user-flow.ts` | Command-line argument parsing and result summary |
| `src/backend/control-flow/live-runner.ts` | Stage input resolution, execution, assertions, and artifacts |
| `src/server/app.ts` | Shared `createRolegainDependencies()` composition root used by UI and live tests |
| `src/backend/control-flow/llm-call-catalog.ts` | Catalog of every production LLM call |
| `src/01-evidence-ingestion/`, `src/02-search/`, `src/02-search/v2/`, `src/03-match/`, `src/04-application-preparation/` | Production pipelines and stages |

## Prerequisites

Run from the repository root:

```bash
npm install
npm run codex:login
codex --version
codex --config 'service_tier="fast"' login status
```

The backend and live runner use the same authenticated Codex home. Resolution
order is:

```text
ROLEGAIN_CODEX_HOME
→ CODEX_HOME
→ ~/.codex
```

The installed CLI should match `SUPPORTED_CODEX_VERSION` in
`src/codex-runtime/protocol.ts`.

The examples use `jq` to inspect JSON:

```bash
jq --version
```

## Runner syntax

Run one stage:

```bash
npm run test:live:stage -- <stage> \
  --input <mock|previous|/absolute/path/to/artifact.json> \
  --artifacts <artifact-root> \
  --target <number>
```

Only `stage` is required. Defaults are:

```text
stage         full
input         mock
artifact root .test-artifacts/live-user-flow
```

`--target` is relevant to discovery and the full flow.

## Input modes

### `--input mock`

The runner constructs a checked synthetic input appropriate for that stage.
The selected stage still uses real model calls and real tools.

### `--input previous`

The runner reads the standard preceding `output.json` from the same artifact
root:

| Current stage | Previous output |
|---|---|
| `evidence-synthesis` | `01a-evidence-reader/output.json` |
| `evidence-verification` | `01b-evidence-synthesis/output.json` |
| `opportunity-research` | `01-evidence/output.json` |
| `discovery` | `01-evidence/output.json` |
| `matching` | `02-search/output.json` |
| `inspection` | `03-match/01-requirement-matching/output.json` |
| `drafting` | `03-match/02-application-inspection/output.json` |

`evidence-reader`, `evidence`, and `full` do not have a `previous` input.

### Explicit artifact path

Any stage can read a JSON artifact explicitly:

```bash
npm run test:live:stage -- matching \
  --input /absolute/path/to/discovery-output.json \
  --artifacts .test-artifacts/matching-experiment
```

The artifact must contain the fields required by that stage. At minimum, most
stages require:

```json
{
  "dataRoot": "/absolute/path/to/persisted/test-data",
  "workspace": {}
}
```

Additional required fields are documented per stage below.

## Artifact directory map

With the default artifact root, output is written to:

```text
.test-artifacts/live-user-flow/
├── 01a-evidence-reader/
├── 01b-evidence-synthesis/
├── 01c-evidence-verification/
├── 01-evidence/
├── 02-search/
├── 03-match/
│   ├── 01-requirement-matching/
│   └── 02-application-inspection/
├── 04-application-preparation/
└── full-user-flow/
```

Every stage directory can contain:

```text
input.json    exact resolved input used by the stage
output.json   successful stage output
failure.json  runtime or acceptance failure after input resolution
```

Malformed paths or JSON can fail before `failure.json` is created. The command
still exits non-zero and prints the error.

Every successful `output.json` has this common envelope:

```json
{
  "stage": "...",
  "createdAt": "...",
  "dataRoot": "...",
  "workspace": {},
  "runtime": {},
  "codexRuns": [],
  "report": {}
}
```

Inspect the common fields:

```bash
jq '{stage, createdAt, dataRoot, runtime, codexRuns, report}' \
  /path/to/output.json
```

## Inspecting exact Codex calls

`output.json.codexRuns` lists only the new `.agent-runtime/runs/` directories
created by that stage.

List them:

```bash
jq -r '.codexRuns[]' /path/to/output.json
```

For each listed directory, inspect:

```text
.agent-runtime/runs/<run-name>/
├── prompt.txt   exact resolved developer instructions and task input
├── schema.json   structured-output schema
├── result.json   final model output
├── events.jsonl  complete Codex event stream
├── stderr.log    runtime diagnostics
└── run.json       call id, role, model, effort, sandbox, tools and timing
```

Example:

```bash
RUN_NAME="paste-one-name-from-codexRuns"

jq . ".agent-runtime/runs/$RUN_NAME/run.json"
sed -n '1,240p' ".agent-runtime/runs/$RUN_NAME/prompt.txt"
jq . ".agent-runtime/runs/$RUN_NAME/result.json"
tail -n 100 ".agent-runtime/runs/$RUN_NAME/events.jsonl"
sed -n '1,200p' ".agent-runtime/runs/$RUN_NAME/stderr.log"
```

## Stage: `evidence-reader`

### Input

Required fields:

```json
{
  "dataRoot": "/path/to/test-data",
  "workspace": {
    "candidateId": "...",
    "sources": [
      {
        "id": "...",
        "kind": "cv",
        "name": "...",
        "content": "...",
        "status": "processing",
        "analysisRequired": true,
        "insights": []
      }
    ]
  }
}
```

`--input mock` uses `mockWorkspaceWithCv()` from
`tests/inspection/evidence-ingestion/fixtures.ts`. It contains one small CV and
therefore produces one chunk.

### Production flow used

```text
readCandidateSourceChunks()
→ chunkSourceWithLocators()
→ mapConcurrentOrdered()
→ evidence.chunk-analysis per uncached chunk
→ evidence.chunk-coverage per reader attempt
→ ordered ChunkReadingResult
```

Implementation:

```text
src/01-evidence-ingestion/v1/02-chunk-reader/index.ts
```

The default chunk size is 20,000 characters with 2,000-character overlap.
Reader concurrency defaults to three and is bounded to one through six via
`ROLEGAIN_ANALYSIS_CONCURRENCY`.

### Run

```bash
npm run test:live:stage -- evidence-reader --input mock
```

### Expected output

Acceptance requires at least one chunk and one source result.

```bash
jq '.report' \
  .test-artifacts/live-user-flow/01a-evidence-reader/output.json
```

Example:

```json
{
  "chunks": 1,
  "sources": 1,
  "claims": 3
}
```

Inspect the direct LLM output for chunk 1:

```bash
jq '.reading.sourceNotes[0].chunks[0]' \
  .test-artifacts/live-user-flow/01a-evidence-reader/output.json
```

Inspect the complete value passed to synthesis:

```bash
jq '.reading' \
  .test-artifacts/live-user-flow/01a-evidence-reader/output.json
```

Expected `reading` shape:

```text
sourceNotes[].chunks[]
  profileFacts
  profileEvidence
  insights
  detailedNotes
  claims
  unknowns
  prohibitedInferences

sourceInsights[]
totalChunks
```

### Run one real Reader and coverage pair with custom text

The runner currently accepts a workspace artifact, not a raw `--chunk` option.
Use the deterministic acquisition stage to create a valid template:

```bash
CHUNK_FILE="/absolute/path/to/chunk.txt"
ARTIFACT_ROOT=".test-artifacts/custom-chunk"

wc -m "$CHUNK_FILE"

npm run test:evidence:stage -- acquisition --input mock \
  --artifacts "$ARTIFACT_ROOT"
```

For exactly one chunk pair (reader plus coverage), the text must be at most
20,000 characters and the workspace must contain only one source requiring
analysis. A failed coverage gate can add one retry pair.

Replace the template CV text:

```bash
jq --rawfile chunk "$CHUNK_FILE" '
  .workspace.sources = [
    .workspace.sources[]
    | select(.kind == "cv")
    | .name = "manual-chunk.txt"
    | .content = $chunk
    | .status = "processing"
    | .analysisRequired = true
    | .insights = []
  ]
  | .workspace.finalCv = $chunk
  | .workspace.intelligence = {status: "analyzing"}
' \
  "$ARTIFACT_ROOT/01-acquisition/output.json" \
  > "$ARTIFACT_ROOT/reader-input.json"
```

Run and inspect the real call:

```bash
npm run test:live:stage -- evidence-reader \
  --input "$PWD/$ARTIFACT_ROOT/reader-input.json" \
  --artifacts "$ARTIFACT_ROOT"

jq '{report, codexRuns, reading}' \
  "$ARTIFACT_ROOT/01a-evidence-reader/output.json"
```

## Stage: `evidence-synthesis`

### Input

Required fields:

```text
dataRoot
workspace
reading.sourceNotes
reading.sourceInsights
reading.totalChunks
```

Input normally comes from `evidence-reader/output.json`.

`--input mock` uses a checked three-chunk `ChunkReadingResult`; the synthesis
LLM is still real.

### Production flow used

```text
synthesizeCandidateEvidence()
→ buildSynthesisPrompt()
→ evidence.synthesis
→ CandidateAnalysisResult
```

Implementation:

```text
src/01-evidence-ingestion/03-synthesis/index.ts
```

### Run

```bash
npm run test:live:stage -- evidence-synthesis --input previous
```

### Expected output and inspection

Acceptance requires at least one source analysis.

```bash
jq '.report' \
  .test-artifacts/live-user-flow/01b-evidence-synthesis/output.json

jq '.analysis' \
  .test-artifacts/live-user-flow/01b-evidence-synthesis/output.json
```

Expected `analysis` fields:

```text
profile
sourceInsights
unknowns
contradictions
prohibitedInferences
roleFamilies
searchVocabulary
threadId
```

The original `.reading` is retained in `output.json`, allowing line-by-line
comparison of Reader input against synthesis output.

## Stage: `evidence-verification`

### Input

Required fields:

```text
dataRoot
workspace with original source text
analysis from evidence synthesis
```

Input normally comes from `evidence-synthesis/output.json`.

### Production flow used

```text
verifyAndPersistEvidence()
→ applyCandidateAnalysis()
→ persist knowledge notes
→ exact-quote claim audit
→ canonical capabilities and readiness
→ persistCanonicalEvidenceRun()
```

Implementation:

```text
src/01-evidence-ingestion/04-verification/index.ts
src/01-evidence-ingestion/04-verification/evidence-model.ts
```

This stage is deliberately deterministic. It makes no LLM call, so
`codexRuns` should be empty.

### Run

```bash
npm run test:live:stage -- evidence-verification --input previous
```

### Expected output and inspection

Acceptance requires `readyForSearch: true`.

```bash
jq '{
  report,
  readiness: .evidenceRun.manifest.readiness,
  directory: .evidenceRun.directory,
  codexRuns
}' .test-artifacts/live-user-flow/01c-evidence-verification/output.json
```

Inspect the persisted canonical files:

```bash
EVIDENCE_DIRECTORY=$(jq -r '.evidenceRun.directory' \
  .test-artifacts/live-user-flow/01c-evidence-verification/output.json)

ls -la "$EVIDENCE_DIRECTORY"
cat "$EVIDENCE_DIRECTORY/claims.jsonl" | jq .
jq . "$EVIDENCE_DIRECTORY/capabilities.json"
jq . "$EVIDENCE_DIRECTORY/role-families.json"
jq . "$EVIDENCE_DIRECTORY/readiness.json"
jq . "$EVIDENCE_DIRECTORY/manifest.json"
```

## Stage: `evidence`

This is the complete CV-ingestion test, not just one internal substep.

### Input

`--input mock` uses the built-in `LIVE_CV` string in
`src/backend/control-flow/live-runner.ts` and a fresh data root under the artifact root.

The current runner does not accept a raw `--cv /path/file.pdf` option. Use the
product API procedure later in this README for an arbitrary uploaded file.

### Production flow used

```text
JobSearchService.addSource()
→ acquireEvidence()
→ uploadCv()
→ JobSearchService.analyzeCandidate()
→ buildCandidateEvidence()
→ Reader LLM per chunk
→ Synthesis LLM
→ deterministic verification
→ prepare fixed live-test intake answers
→ JobSearchService.finishIntake()
```

### Run

```bash
npm run test:live:stage -- evidence --input mock
```

### Expected output and inspection

Acceptance requires `workspace.intelligence.status === "ready"` and a
search-ready canonical evidence run.

```bash
jq '{
  report,
  phase: .workspace.phase,
  intelligence: .workspace.intelligence,
  sources: [.workspace.sources[] | {
    id, kind, name, status, analysisRequired,
    insightCount: (.insights | length)
  }],
  codexRuns
}' .test-artifacts/live-user-flow/01-evidence/output.json
```

This output is the standard `previous` input for discovery.

## Stage: `discovery`

### Input

Required fields:

```text
dataRoot containing the canonical evidence files
workspace containing the exact evidence-run pointer
confirmed search preferences
```

Input modes:

- `previous`: real output of the complete `evidence` stage;
- explicit path: another search-ready evidence artifact;
- `mock`: deterministically persists checked synthetic evidence, then performs
  real web discovery and real vacancy validation.

### Production flow used

```text
LiveOpportunityResearcher.research()
→ searchAndValidateOpportunities()
→ search.web-discovery in adaptive waves
→ browser snapshot acquisition
→ search.listing-extraction when a result is a list page
→ search.vacancy-verification per concrete job
→ URL dedupe and hard-constraint checks
```

Implementations:

```text
src/03-match/opportunity-researcher.ts
src/02-search/v1/01-discovery/index.ts
src/02-search/v1/03-vacancy-validation/index.ts
```

### Run

From real evidence:

```bash
npm run test:live:stage -- discovery --input previous
```

Independently with deterministic evidence input:

```bash
npm run test:live:stage -- discovery --input mock --target 3
```

### Expected output and inspection

Acceptance requires at least one live-validated opportunity with HTTP(S) source
and application URLs plus `lastValidatedAt`.

```bash
jq '.report' \
  .test-artifacts/live-user-flow/02-search/output.json

jq '[.opportunities[] | {
  id, company, title, location, workplace,
  sourceUrl, applyUrl, lastValidatedAt,
  validation
}]' .test-artifacts/live-user-flow/02-search/output.json

jq '.research.failures' \
  .test-artifacts/live-user-flow/02-search/output.json
```

Use the complete output as matching input; do not pass only the jobs array,
because matching also needs `workspace`, `dataRoot`, and canonical evidence.

## Stage: `matching`

### Input

Required fields:

```text
dataRoot
workspace with canonical evidence pointer
opportunities[] or research.opportunities[]
```

Input modes:

- `previous`: real discovery output;
- explicit path: any compatible discovery artifact;
- `mock`: checked synthetic live-marked job plus deterministic evidence, while
  every model call used by the selected matching version remains real.

### Production flow used

```text
LiveOpportunityResearcher.assess()
→ matchOpportunities()
→ match.requirements per job
→ v1: Tier 2, fresh verification, and bounded repair when needed
→ v2: calibrated one-pass matrix without semantic verifier/repair calls
→ deterministic score and persistence
```

Implementation:

```text
src/03-match/shared/01-requirement-matching/index.ts
```

### Run

```bash
npm run test:live:stage -- matching --input previous
```

Independent real matching test:

```bash
npm run test:live:stage -- matching --input mock
```

### Expected output and inspection

Acceptance requires at least one opportunity and at least one requirement row
per opportunity.

```bash
jq '.report' \
  .test-artifacts/live-user-flow/03-match/01-requirement-matching/output.json

jq '[.opportunities[] | {
  id, company, title, fit, strengths, gaps,
  requirementMatches
}]' .test-artifacts/live-user-flow/03-match/01-requirement-matching/output.json
```

Inspect citations used for requirement matches:

```bash
jq '[
  .opportunities[]
  | .requirementMatches[]
  | {
      requirement,
      status,
      matchClass,
      confidence,
      evidence
    }
]' .test-artifacts/live-user-flow/03-match/01-requirement-matching/output.json
```

## Stage: `inspection`

### Input

Required fields:

```text
dataRoot
workspace
opportunities[] containing currently accessible matched jobs
```

`inspection --input mock` is intentionally rejected. A fake URL cannot test
real employer navigation or form mapping. Use `previous` or an explicit live
matching artifact.

### Production flow used

```text
LiveOpportunityResearcher.inspectApplications()
→ inspectOpportunityApplications()
→ browser loads employer application page
→ application.navigate when the form is not initially visible
→ application.field-map
→ application.schema-verify
```

Implementation:

```text
src/03-match/02-application-inspection/index.ts
```

### Run

```bash
npm run test:live:stage -- inspection --input previous
```

### Expected output and inspection

Acceptance requires at least one application with
`liveFormValidated === true`.

```bash
jq '.report' \
  .test-artifacts/live-user-flow/03-match/02-application-inspection/output.json

jq '[.inspection.applications[] | {
  id, jobId, adapter, liveFormValidated,
  formSchema,
  formFields: [.formFields[] | {
    id, externalName, label, type, required, source, confidence
  }]
}]' .test-artifacts/live-user-flow/03-match/02-application-inspection/output.json

jq '.inspection.failures' \
  .test-artifacts/live-user-flow/03-match/02-application-inspection/output.json
```

## Stage: `drafting`

### Input

Required fields:

```text
dataRoot with canonical evidence
workspace
opportunities[]
inspection.applications[] with liveFormValidated and mapped formFields
```

Input modes:

- `previous`: real inspection output;
- explicit path: any compatible inspection artifact;
- `mock`: synthetic mapped application and deterministic evidence, while the
  writer, verifier, and conditional repair calls remain real.

### Production flow used

```text
CodexCoverLetterWriter.draft()
→ buildApplicationContext() deterministically
→ application.draft
→ application.verify independently
→ application.repair once for failures
→ final application.verify for repaired drafts
```

Implementations:

```text
src/04-application-preparation/application-preparation.ts
src/04-application-preparation/01-context/index.ts
src/04-application-preparation/02-draft/index.ts
src/04-application-preparation/03-verification/index.ts
src/04-application-preparation/04-repair/index.ts
```

### Run

```bash
npm run test:live:stage -- drafting --input previous
```

Independent real drafting test:

```bash
npm run test:live:stage -- drafting --input mock
```

### Expected output and inspection

Acceptance requires exactly one accepted draft for every eligible mapped
application.

```bash
jq '.report' \
  .test-artifacts/live-user-flow/04-application-preparation/output.json

jq '.drafts' \
  .test-artifacts/live-user-flow/04-application-preparation/output.json

jq '[.filledApplications[] | {
  id, jobId, status, coverLetter,
  answers: [.formFields[] | {
    id, label, value, evidence
  }]
}]' .test-artifacts/live-user-flow/04-application-preparation/output.json
```

## Full user flow

### Production flow used

The full stage constructs the same dependencies as the UI and invokes:

```text
upload built-in live CV
→ complete evidence ingestion
→ prepare fixed intake answers
→ finish intake
→ JobSearchService.prepareApplications()
→ adaptive discovery and validation
→ selected v1 or v2 requirement matching flow
→ employer-form inspection
→ application drafting and verification
→ requested number of agent-prepared applications
```

### Run

The default target is five:

```bash
npm run test:live:flow
```

Use one application while debugging:

```bash
npm run test:live:flow -- --target 1
```

Use a separate artifact root:

```bash
npm run test:live:stage -- full --input mock --target 1 \
  --artifacts .test-artifacts/full-flow-debug
```

### Expected output and inspection

The test fails unless it produces at least the requested number of
agent-prepared applications backed by live-validated jobs.

```bash
jq '.report' \
  .test-artifacts/live-user-flow/full-user-flow/output.json

jq '[.filledApplications[] | {
  id, jobId, status, addedBy,
  formFieldCount: (.formFields | length),
  answeredFieldCount: ([.formFields[] | select(.value != "")] | length),
  coverLetter
}]' .test-artifacts/live-user-flow/full-user-flow/output.json

jq '[.opportunities[] | {
  id, company, title, sourceUrl, applyUrl,
  lastValidatedAt, validation
}]' .test-artifacts/live-user-flow/full-user-flow/output.json
```

Partial workspace, search audit, rejected jobs, and validation issues remain in
the artifact data root when the target cannot be reached.

## Custom CV plus webpage through the production API

The stage runner currently does not accept `--cv` and `--webpage` arguments.
To test arbitrary files and URLs through the exact upload API, add both sources
with analysis deferred and then trigger one combined analysis.

This procedure modifies the application’s normal `data/` workspace and
replaces its current CV. Use test inputs.

Start the backend:

```bash
npm start
```

In another terminal:

```bash
CV_FILE="/absolute/path/to/cv.pdf"
WEB_SOURCE="https://example.com/project-page"
API_BASE="http://127.0.0.1:4317"
RESULT_ROOT=".test-artifacts/cv-webpage"

mkdir -p "$RESULT_ROOT"

CV_BASE64=$(base64 < "$CV_FILE" | tr -d '\n')
CV_NAME=$(basename "$CV_FILE")

jq -n \
  --arg name "$CV_NAME" \
  --arg data "$CV_BASE64" \
  '{
    kind: "cv",
    name: $name,
    dataBase64: $data,
    deferAnalysis: true
  }' |
curl --fail-with-body --silent --show-error \
  -X POST "$API_BASE/api/job-search/sources" \
  -H "Content-Type: application/json" \
  --data-binary @- \
  > "$RESULT_ROOT/01-cv-upload.json"

jq -n \
  --arg url "$WEB_SOURCE" \
  '{
    kind: "webpage",
    name: $url,
    url: $url,
    deferAnalysis: true
  }' |
curl --fail-with-body --silent --show-error \
  -X POST "$API_BASE/api/job-search/sources" \
  -H "Content-Type: application/json" \
  --data-binary @- \
  > "$RESULT_ROOT/02-webpage-acquisition.json"

curl --fail-with-body --silent --show-error \
  -X POST "$API_BASE/api/job-search/analyze" \
  -H "Content-Type: application/json" \
  -d '{}' \
  > "$RESULT_ROOT/03-analyzed-workspace.json"

curl --fail-with-body --silent --show-error \
  "$API_BASE/api/job-search/candidates/candidate-1/evidence" \
  > "$RESULT_ROOT/04-canonical-evidence.json"
```

Inspect source status and readiness:

```bash
jq '{
  status: .intelligence.status,
  evidenceRun: .intelligence.evidenceRun,
  sources: [.sources[] | {
    id, kind, name, url, status, analysisRequired,
    insightCount: (.insights | length)
  }]
}' "$RESULT_ROOT/03-analyzed-workspace.json"
```

Inspect every canonical claim and its CV/webpage provenance:

```bash
jq '[.claims[] | {
  claimId, action, capability, supportStatus,
  sourceRefs: [.sourceRefs[] | {
    sourceId, sourceVersionId, locator, quote
  }]
}]' "$RESULT_ROOT/04-canonical-evidence.json"
```

Show claims backed by more than one source:

```bash
jq '[
  .claims[]
  | select(.sourceRefs | length > 1)
  | {claimId, action, capability, sourceRefs}
]' "$RESULT_ROOT/04-canonical-evidence.json"
```

With evidence v1, one small CV and one small webpage produce two Reader/coverage
pairs followed by one Synthesis call; failed coverage may add a targeted repair
round. Evidence v2 uses one lean reader call per chunk, plus only a
grounding-rejection retry when necessary, followed by the same Synthesis call.

## Running the stages serially

Use one artifact root for the entire handoff chain:

```bash
ARTIFACT_ROOT=".test-artifacts/live-serial"

npm run test:live:stage -- evidence-reader --input mock \
  --artifacts "$ARTIFACT_ROOT"
npm run test:live:stage -- evidence-synthesis --input previous \
  --artifacts "$ARTIFACT_ROOT"
npm run test:live:stage -- evidence-verification --input previous \
  --artifacts "$ARTIFACT_ROOT"
```

The internal evidence-substep chain is separate from the complete `evidence`
stage. Discovery’s `previous` mapping intentionally points to the complete
`evidence` output because that stage also prepares intake preferences and moves
the workspace into the search phase.

Continue the product-level chain:

```bash
npm run test:live:stage -- evidence --input mock \
  --artifacts "$ARTIFACT_ROOT"
npm run test:live:stage -- discovery --input previous \
  --artifacts "$ARTIFACT_ROOT"
npm run test:live:stage -- matching --input previous \
  --artifacts "$ARTIFACT_ROOT"
npm run test:live:stage -- inspection --input previous \
  --artifacts "$ARTIFACT_ROOT"
npm run test:live:stage -- drafting --input previous \
  --artifacts "$ARTIFACT_ROOT"
```

## Failure inspection

On a stage failure:

```bash
jq . /path/to/stage/failure.json
```

Important fields:

```text
stage       failed stage
input       mock, previous, or explicit input selection
dataRoot    persisted state retained for diagnosis
runtime     resolved Codex binary, version, authentication and models
error       acceptance or runtime failure
codexRuns   exact turns created before failure
```

Then inspect every listed Codex run’s `stderr.log`, `events.jsonl`, and
`result.json`.

Common failures:

| Failure | Meaning |
|---|---|
| `Codex is not authenticated` | Authenticate the selected Codex home with `npm run codex:login` |
| No validated jobs | Search returned no currently accessible vacancy satisfying the gate |
| No requirement matrix | Matching returned no accepted job or malformed requirement evidence |
| No employer form mapped | Forms were protected, removed, inaccessible, or unsupported |
| Independent verification rejected draft | Draft remained defective after one bounded repair |
| Fewer applications than target | The bounded full flow could not produce the promised quota |

## Deterministic companion tests

Use deterministic tests when debugging orchestration or schemas without model
cost and changing web state:

```bash
npm run test:evidence:steps
npm run test:evidence:serial
npm test
```

Their operating guide is:

```text
tests/inspection/evidence-ingestion/README.md
```
