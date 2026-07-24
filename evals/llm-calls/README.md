# LLM Calls Evals

This suite covers every production LLM call in `src/backend/control-flow/llm-call-catalog.ts`.
It is intentionally separate from the deeper match-requirements eval:

- `evals/llm-calls` checks catalog coverage, output schemas, semantic invariants,
  and flow coverage for all calls.
- `evals/match-requirements` remains the high-depth behavioral eval for
  requirement matching, verification, repair, and the full requirement flow.

## Run

Fast contract mode, no model calls:

```powershell
npm run eval:llm-calls
```

Run selected live smoke cases through Codex:

```powershell
npm run eval:llm-calls -- --live --cases search.listing-extraction,application.field-map --model gpt-5.4-mini
```

Filter by suite:

```powershell
npm run eval:llm-calls -- --suites search.components,application-preparation.components
```

## Output

Each run writes:

- `run-config.json`
- `summary.json`
- `flows.json`
- `trials.jsonl`
- `report.md`
- one artifact directory per call with `gold.json`, `prompt.json`, `trial.json`,
  and optional live output/call traces.

## Flow Coverage

Flow evals verify that each top-level flow has:

- declared LLM call ids in the production catalog;
- matching component eval cases;
- runnable numbered stages where the stage is intended to be a standalone CLI
  stage.
