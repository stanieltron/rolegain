# Search

[Repository map](../../README.md) |
[Search facade](../03-match/opportunity-researcher.ts) |
[Next pipeline](../03-match/README.md)

Search loads one exact search-ready evidence run, discovers public vacancy
leads, expands resumable vacancy sources when needed, and validates concrete
job pages. Its output is a set of live, validated opportunities plus rejected
search failures. It does not score candidate fit and it does not inspect
application forms; those belong to `03-match`.

## Architecture

| Folder | Responsibility | Public surface |
|---|---|---|
| [`v1/`](./v1/README.md) | Adaptive discovery, resumable source expansion, extraction, and independent verification | `index.ts`, `contracts.ts`, `schemas.ts`, `README.md` |
| [`v2/`](./v2/README.md) | Independent capture-first discovery and batched frozen-page classification | `index.ts`, `contracts.ts`, `schemas.ts`, `README.md` |

V1's `02-vacancy-source-expansion` is a branch, not a mandatory step for every
candidate. Concrete vacancy leads go directly to validation. Vacancy-source
leads first resume their source checkpoint, emit child vacancy leads, and every
child enters the same validation queue.

Shared search/match contracts and deterministic utilities live in
[`../search-match-shared/`](../search-match-shared/README.md).

## Public Runners

`npm run stage -- search.run` runs discovery plus validation and returns
validated opportunities.

`npm run stage -- search.discovery` exposes the same live search boundary for
inspection.

`npm run stage -- search.validate-vacancies` reopens supplied job URLs and
validates them without running web discovery.

## LLM Calls

| Call id | Location | Purpose |
|---|---|---|
| `search.web-discovery` | `v1/01-discovery/llm-calls/01-web-search/` | V1 bounded discovery wave; v2 exposes its discovery schema from `v2/schemas.ts` |
| `search.source-navigation` | `v1/02-vacancy-source-expansion/browser-agent/llm-calls/01-source-navigation/` | V1 bounded navigation decisions |
| `search.listing-extraction` | `v1/03-vacancy-validation/llm-calls/01-listing-extraction/` | V1 listing extraction |
| `search.vacancy-verification` | `v1/03-vacancy-validation/llm-calls/02-vacancy-verification/` | V1 frozen-vacancy verification; v2 uses frozen capture classification |

## Handoff

Search hands validated `JobOpportunity[]`, failures, seen URLs, and the exact
evidence-run id to [`03-match`](../03-match/README.md). Match may consume those
opportunities in a serialized artifact or stream them from validation through a
bounded orchestrator.

## Version selection

Search v1 remains the default for `npm run dev` and `npm start`. The complete
`npm run dev:v2` / `npm run start:v2` launchers select
[search v2](./v2/README.md), evidence ingestion v2, and matching v2
together. Set only `ROLEGAIN_SEARCH_VERSION=v2` when intentionally comparing
search implementations while leaving the other pipelines unchanged.
