# Search v2

Search v2 is an independent capture-first discovery implementation. The
existing `src/02-search` pipeline remains available as v1 and is not imported by
this directory.

## Start the server with v2

```bash
npm run dev:v2
npm run start:v2
npm run dev:diagnostic:v2
```

For Railway or another deployment, set:

```text
ROLEGAIN_SEARCH_VERSION=v2
```

Without that variable, the server continues to use v1.

## Flow

1. A bounded web-search call produces typed vacancy or job-list leads.
2. Playwright captures pages concurrently. Weak, failed, download-triggered,
   and blocked captures receive one public-HTTP fallback with redirect safety.
3. Full pages are reduced into deterministic signals for exact title identity,
   definite closure, conditional closure, staffing pools, loading application
   pages, structured JobPosting data, forms, and relevant links.
4. Usable captures are classified once in medium batches. There is no verifier
   or repair call. Empty captures are the only deterministic model bypass.
5. Job-list children are validated once. Same-page roles are accepted as child
   cards using the parent source URL; nested list recursion is bounded.
6. Current vacancies pass candidate workplace and compensation gates, then
   stream directly into matching.

The medium default batch size of 32 is deliberate: the 200-page benchmark found
that one giant call was accurate but slow, while eight-page batches repeated too
much runtime context. Capture concurrency is 10 and classifier concurrency is
3 by default.

## Harness artifacts

Each run writes an inspectable directory under:

```text
data/job-search/runs/<candidate>/search-v2-runs/<search-run-id>/
```

It contains the manifest, wave timings, frozen captures, classification
decisions, accepted opportunities, and failures. V2 artifacts never share the
v1 source inventory or validation state.

## Tuning

| Variable | Default |
| --- | ---: |
| `ROLEGAIN_SEARCH_V2_CAPTURE_CONCURRENCY` | 10 |
| `ROLEGAIN_SEARCH_V2_BATCH_SIZE` | 32 |
| `ROLEGAIN_SEARCH_V2_CLASSIFICATION_CONCURRENCY` | 3 |
| `ROLEGAIN_SEARCH_V2_NAVIGATION_TIMEOUT_MS` | 15000 |
| `ROLEGAIN_SEARCH_V2_SETTLE_MS` | 650 |
| `ROLEGAIN_SEARCH_V2_MAX_WAVES` | 4 |
| `ROLEGAIN_SEARCH_V2_CHILDREN_PER_SOURCE` | 8 |

