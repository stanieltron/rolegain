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

| Folder | Responsibility | Execution |
|---|---|---|
| [`01-discovery/`](./01-discovery/README.md) | Run bounded web-search waves and classify each result as a concrete vacancy or a vacancy source | Hybrid |
| [`02-vacancy-source-expansion/`](./02-vacancy-source-expansion/README.md) | Resume persistent listing cursors and emit concrete child vacancies | Hybrid branch |
| [`03-vacancy-validation/`](./03-vacancy-validation/README.md) | Open each concrete vacancy, freeze the page, verify it, and enforce hard constraints | Hybrid |
| [`browser/`](./browser/README.md) | Shared browser-side scripts used during search and form inspection | Deterministic |

`02-vacancy-source-expansion` is a branch, not a mandatory step for every
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
| `search.web-discovery` | `01-discovery/llm-calls/01-web-search/` | One call per bounded search wave |
| `search.source-navigation` | `02-vacancy-source-expansion/browser-agent/llm-calls/01-source-navigation/` | Bounded navigation decisions for interactive vacancy sources |
| `search.listing-extraction` | `03-vacancy-validation/llm-calls/01-listing-extraction/` | Extract concrete vacancies from captured listing pages |
| `search.vacancy-verification` | `03-vacancy-validation/llm-calls/02-vacancy-verification/` | Verify a frozen vacancy snapshot before it can enter match |

## Handoff

Search hands validated `JobOpportunity[]`, failures, seen URLs, and the exact
evidence-run id to [`03-match`](../03-match/README.md). Match may consume those
opportunities in a serialized artifact or stream them from validation through a
bounded orchestrator.
