# Evidence ingestion v2

V2 is the opt-in, benchmark-driven reader selected with
`ROLEGAIN_EVIDENCE_VERSION=v2`. V1 remains the default rollback path.

`npm run dev:v2`, `npm run start:v2`, and `npm run dev:diagnostic:v2` enable
this reader together with search v2 and matching v2. Set only
`ROLEGAIN_EVIDENCE_VERSION=v2` when intentionally benchmarking ingestion in
isolation.

## Public package

| File | Contract |
| --- | --- |
| [`index.ts`](./index.ts) | V2 analyzer and reader entry points |
| [`contracts.ts`](./contracts.ts) | Shared result types plus the lean extraction contract |
| [`schemas.ts`](./schemas.ts) | Lean chunk-analysis and shared synthesis schemas |
| [`README.md`](./README.md) | Version behavior, benchmark, and limitations |

```text
one lean atomic extraction call per uncached chunk (six concurrent by default)
  -> deterministic schema and exact-quote gateway
  -> one grounding-only retry when rejected
  -> ordered join
  -> existing synthesis and canonical verification
```

The normal path has no semantic coverage-verifier or repair call. V2 uses its
own checkpoint namespace, so switching versions cannot mix reader outputs.

## Matching benchmark

The frozen benchmark contains the complete CV and all 16 captured portfolio
blocks (196,709 source characters). Manual review first identified 335
source-supported facts, then retained 262 that can directly support a plausible
job requirement. Contact metadata, generic product exposition, worked-example
arithmetic, redundant intermediate simulation variants, and planned future work
were excluded. Every retained fact has exact source anchors.

All fresh alternatives below used the same model and frozen corpus. Recall is
measured only after invalid quotations are removed.

| Reader design | Calls | Wall time | Fact recall | Valid quotes |
| --- | ---: | ---: | ---: | ---: |
| four large batches, medium reasoning | 4 | 154.6 s | 156/262 (59.5%) | 89.3% |
| nine adjacent batches, medium reasoning | 9 | 137.7 s | 190/262 (72.5%) | 95.9% |
| **one block per call, low reasoning** | **17** | **141.6 s** | **209/262 (79.8%)** | **99.5%** |
| one block per call, medium reasoning | 17 | 180.3 s | 219/262 (83.6%) | 99.8% |
| old production prompt/schema, one block, low reasoning | 17 | 233.5 s | 102/262 (38.9%) | 90.9% |

The low-reasoning isolated reader is the selected tradeoff. Medium reasoning
cost 38.8 additional seconds and 11,270 additional output tokens for 10 more
facts. Pair batching saved only 3.9 seconds while losing 19 facts. Large batches
were slower than pairs, lost much more evidence, and produced more invalid
quotations.

The old rich reader contract asked the same call to produce atomic claims,
insights, 300-800 words of knowledge notes, unknowns, and prohibited inferences.
It was both the slowest fresh run and the least useful for matching: evidence was
compressed or placed into narrative fields instead of atomic claims. V2 now
uses a lean extraction contract and deterministically expands its claims into
the existing `SourceChunkNotes` boundary, including source insights and compact
knowledge notes. Explicit dates and measured outcomes remain available as
optional structured claim fields.

The earlier v1 coverage experiment is still relevant: on this benchmark the
archived production first pass and its 23 coverage plus 7 repair calls both
recovered 105/262 facts. Those 30 extra calls added zero benchmark facts. The
canonical ledger retained 91/262, identifying canonicalization as a separate
recall boundary.

## Limitations

- Each fresh variant was run once; latency and model output are stochastic.
- The corpus covers one candidate's CV and portfolio, not every source type.
- The benchmark measures fact recall and quote grounding, not the quality of
  downstream role-family synthesis or final job matches.
- A grounding retry may add calls and latency when the first result contains an
  invalid quote; the selected run had two invalid records across 17 blocks.
