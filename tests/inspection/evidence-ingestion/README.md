# Evidence-ingestion inspection tests

These tests are organized like the production flow. Every test name starts
with the stage and substep it exercises, and every model call uses deterministic
mock output.

## Focused tests

```bash
npm run test:evidence:steps
```

| File | Covered boundaries |
|---|---|
| `01-acquisition.steps.test.ts` | CV read/store/install/invalidate, CV replacement, supplemental normalization/hash/deduplication, profile-link acquisition |
| `02-chunk-reader.steps.test.ts` | one chunk, three chunks, one Reader LLM call, model locator replacement, progress, multi-chunk consolidation |
| `03-synthesis.steps.test.ts` | three-chunk reducer input, exactly one Synthesis LLM call, reader-owned claim preservation |
| `04-verification.steps.test.ts` | profile/insight application, knowledge note, exact-quote acceptance, invented-quote rejection, readiness publication |
| `serial-pipeline.test.ts` | complete ordered flow and mock/previous/path input modes |

Shared mock data is in `fixtures.ts`. The deterministic Codex double and its
recorded model-call boundary are in `mock-codex.ts`.

## Inspect every stage in serial

```bash
npm run test:evidence:serial
```

This runs:

```text
acquisition
  → reader
  → synthesis
  → verification
  → search-handoff
```

The final `search-handoff` does not perform live job search. It exercises the
real Flow 02 boundary that loads the published canonical evidence and builds
the discovery input packet.

Outputs are written under `.test-artifacts/evidence-ingestion/`. Each stage has:

```text
input.json         exact resolved input
output.json        exact stage output and workspace
model-calls.json   call id, prompt, model options, and schema for mocked calls
```

## Run one stage

Use its independent mock:

```bash
npm run test:evidence:stage -- synthesis --input mock
```

Use the standard output of the preceding stage:

```bash
npm run test:evidence:stage -- reader --input previous
```

Use any explicit artifact, including one copied or edited by hand:

```bash
npm run test:evidence:stage -- synthesis \
  --input /absolute/path/to/02-reader/output.json
```

Available stages are `acquisition`, `reader`, `synthesis`, `verification`, and
`search-handoff`.

The tests themselves remain independent. Vitest file ordering is not used as
hidden state; serial chaining happens only through the explicit JSON artifact
selected with `--input`.
