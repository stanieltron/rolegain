# Search-and-match shared modules

[Back to Search](../README.md)

These modules contain deterministic behavior genuinely used by more than one
numbered stage. Stage-specific orchestration remains in its owning stage.

| Module | Responsibility |
|---|---|
| `browser-pool.ts` | Track browser processes, enforce execution generations, and close active browsers on cancellation |
| `evidence-context.ts` | Load the exact canonical evidence run, build search lanes, retrieve claim subsets, and validate citations |
| `knowledge-context.ts` | Load and validate the evidence wiki, route vacancies through its index, and select bounded relevant page excerpts |
| `opportunity.ts` | Shared vacancy normalization, constraint checks, compensation parsing, confidence, failure construction, and job-text extraction |
| `parallel.ts` | Bounded ordered fan-out and configured limits for validation and matching |
| `progress.ts` | Stable UI progress identities for leads and opportunities |
| `search-intent.ts` | Convert confirmed workplace/location/language preferences into search intent |

Nothing in this directory calls an LLM. If behavior is used by only one stage,
it belongs in that stage instead of being moved here for convenience.
