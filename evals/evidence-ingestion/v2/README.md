# Evidence ingestion v2 eval

Run `npm run eval:evidence:v2`. It uses the same frozen cases and grader as v1,
writes under `.test-artifacts/evidence-evals/v2/`, and records `version: "v2"`
on every trial. Schemas come from
[`src/01-evidence-ingestion/v2/schemas.ts`](../../../src/01-evidence-ingestion/v2/schemas.ts).
