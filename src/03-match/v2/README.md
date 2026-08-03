# Matching v2

Enable with `ROLEGAIN_MATCH_VERSION=v2`. V1 remains the default rollback path.

`npm run dev:v2`, `npm run start:v2`, and `npm run dev:diagnostic:v2` enable
matching v2 together with evidence ingestion v2 and search v2. Set only
`ROLEGAIN_MATCH_VERSION=v2` when intentionally benchmarking matching in
isolation.

## Public package

| File | Contract |
| --- | --- |
| [`index.ts`](./index.ts) | Version-pinned batch and single-job entry points |
| [`contracts.ts`](./contracts.ts) | Batch and single-job input types |
| [`schemas.ts`](./schemas.ts) | Calibrated one-pass requirement schema |
| [`README.md`](./README.md) | Version behavior and benchmark decision |

Shared deterministic citation filtering, scoring, and persistence live in
[`../shared/01-requirement-matching`](../shared/01-requirement-matching/README.md).

V2 is the benchmark-selected one-pass matcher: low reasoning, a lean output
contract, calibrated responsibility-versus-qualification adjacency, exact
canonical citations, and deterministic final scoring/filtering. It skips the
standard Tier-2, verifier, and repair calls because the frozen benchmark showed
that chain was slower and less accurate than the calibrated first pass.

The empty-result recovery turn remains as a bounded structural fallback.
