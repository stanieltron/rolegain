# LLM Calls Evals

This suite covers every production LLM call in `src/backend/control-flow/llm-call-catalog.ts`.
It is intentionally separate from the deeper match-requirements eval:

- `evals/llm-calls` checks catalog coverage, output schemas, semantic invariants,
  and flow coverage for all calls.
- `evals/match-requirements` remains the high-depth behavioral eval for
  knowledge routing, requirement matching, verification, repair, and the full
  requirement flow.

## Run

Fast contract mode, no model calls:

```powershell
npm run eval:llm-calls
```

Run selected live smoke cases through Codex:

```powershell
npm run eval:llm-calls -- --live --cases search.listing-extraction,application.field-map --model gpt-5.4-mini
```

Override both model and reasoning effort for selected live cases:

```powershell
npm run eval:llm-calls -- --live --cases search.listing-extraction --model gpt-5.6-sol --effort medium
```

Run the default model/effort matrix against every opt-in LLM call. This runs
baseline plus 16 candidate variants for each call, so keep concurrency modest:

```powershell
npm run eval:llm-calls -- --matrix --all-live --concurrency 2
```

Run the matrix against a smaller shakedown set:

```powershell
npm run eval:llm-calls -- --matrix --cases search.listing-extraction,application.field-map --concurrency 2
```

Use a custom matrix when you only want a subset:

```powershell
npm run eval:llm-calls -- --matrix --cases match.requirements --pairs gpt-5.6-sol:medium,gpt-5.5:high
```

## Production Defaults

The tested calls use the fastest model/effort pair that passed every captured
real-input replay for that call:

| Calls | Production default |
| --- | --- |
| `evidence.chunk-analysis`, `evidence.chunk-coverage`, `evidence.chunk-repair` | `gpt-5.6-luna`, low |
| `evidence.synthesis` | `gpt-5.6-terra`, low |
| `search.web-discovery`, `search.listing-extraction`, `search.vacancy-verification` | `gpt-5.6-luna`, low |
| `match.requirements` | `gpt-5.6-terra`, medium |
| `match.tier2-evidence` | `gpt-5.6-terra`, low |
| `match.verification` | `gpt-5.6-luna`, low |
| `match.repair` | `gpt-5.5`, low |

Explicit eval/inspection model arguments override the complete invoked flow.
Operator environment variables such as `ROLEGAIN_FAST_MODEL` and
`ROLEGAIN_SEARCH_MODEL` override their corresponding per-call defaults.
Calls without complete real-input matrix coverage retain their existing
production defaults.

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

Matrix runs write under `.agent-runtime/llm-calls/matrix-runs/` by default and
add:

- `matrix-config.json`
- per-variant artifact directories
- fastest-passing-candidate tables in `report.md`

## Flow Coverage

Flow evals verify that each top-level flow has:

- declared LLM call ids in the production catalog;
- matching component eval cases;
- runnable numbered stages where the stage is intended to be a standalone CLI
  stage.
