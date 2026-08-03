# Evidence ingestion v1

V1 is the default evidence implementation. It owns the rich chunk reader,
semantic coverage review, and bounded repair loop under
[`02-chunk-reader`](./02-chunk-reader/README.md). Acquisition, synthesis, and
canonical verification are shared with v2 and remain one level above this
package.

## Public package

| File | Contract |
| --- | --- |
| [`index.ts`](./index.ts) | V1 analyzer and chunk-reader entry points |
| [`contracts.ts`](./contracts.ts) | Input, progress, chunk, and result types |
| [`schemas.ts`](./schemas.ts) | Chunk analysis, coverage, repair, and shared synthesis schemas |
| [`README.md`](./README.md) | Version behavior and ownership |

V1 runs reader → coverage → bounded repair for each chunk, then rejoins the
shared synthesis and canonical verification stages. It is selected by default
or explicitly with `ROLEGAIN_EVIDENCE_VERSION=v1`.
