# Search v1

V1 is the default adaptive discovery pipeline. It performs model-led discovery,
vacancy-source expansion, listing extraction, and independent vacancy
verification.

## Public package

| File | Contract |
| --- | --- |
| [`index.ts`](./index.ts) | Complete v1 search entry point |
| [`contracts.ts`](./contracts.ts) | Search input and output types |
| [`schemas.ts`](./schemas.ts) | Discovery, navigation, extraction, and verification schemas |
| [`README.md`](./README.md) | Version behavior and ownership |

The implementation lives in
[`01-discovery`](./01-discovery/README.md),
[`02-vacancy-source-expansion`](./02-vacancy-source-expansion/README.md), and
[`03-vacancy-validation`](./03-vacancy-validation/README.md). Select it by
default or explicitly with `ROLEGAIN_SEARCH_VERSION=v1`.
