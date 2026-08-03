# Matching v1

V1 is the default multi-stage requirement matcher. It performs the initial
requirement matrix, bounded Tier-2 evidence lookup, independent verification,
and one repair cycle when required.

## Public package

| File | Contract |
| --- | --- |
| [`index.ts`](./index.ts) | Version-pinned batch and single-job entry points |
| [`contracts.ts`](./contracts.ts) | Batch and single-job input types |
| [`schemas.ts`](./schemas.ts) | Requirement, Tier-2, verification, and repair schemas |
| [`README.md`](./README.md) | Version behavior and ownership |

Shared deterministic matching and citation logic lives in
[`../shared/01-requirement-matching`](../shared/01-requirement-matching/README.md).
Select v1 by default or explicitly with `ROLEGAIN_MATCH_VERSION=v1`.
