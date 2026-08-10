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
| [`schemas.ts`](./schemas.ts) | Lean chunk-analysis and v2 synthesis schemas |
| [`README.md`](./README.md) | Version behavior, benchmark, and limitations |

```text
captured pages isolated into 20k-character chunks with 1.5k overlap
  -> parallel wave
     -> up to twenty low-reasoning seven-field readers
        (fact, capability, keywords, ownership, maturity, scope, quote)
        using the v2 completeness skill with explicit project-level evidence
     -> one compact CV + portfolio-overview role/profile synthesis
  -> deterministic schema and exact-quote gateway
  -> one grounding-only retry when rejected
  -> ordered deterministic join and provenance/vocabulary expansion
  -> canonical verification
```

The normal path has no semantic coverage-verifier or repair call. Set
`ROLEGAIN_EVIDENCE_V2_CONCURRENCY` to reduce the twenty-reader default when a
provider has a lower parallel-request limit. V2 uses its own checkpoint
namespace inside the configured data root, so switching versions, reader
generations, users, or side-by-side local workspaces cannot mix outputs. Dense
technical chunks receive a final paragraph/bullet rescan and retain at most 34
of the most job-distinguishing atomic facts.

## Current local-v1 benchmark (2026-08-05)

The current candidate input was frozen directly from the local v1 workspace:
a 5,926-character CV and a 229,701-character, 12-page portfolio capture. Source
drift left 240 of the previously hand-adjudicated job-matching facts exactly
anchorable. Local v1 exposed 34 of those facts through its canonical citations
and rendered insights, so scoring reports both broad manual recall and strict
retention of facts known to have survived v1.

All five initial approaches used the same frozen input and model. Times cover
the parallel reader fan-out, not acquisition, synthesis, or canonical
persistence. Their exploratory profile-fact schema allowed arbitrary field
names, so these runs are useful for chunk/prompt direction but are not the final
production-contract measurement.

| Progressive reader approach | Blocks / concurrency | Reasoning | Wall time | Manual recall | V1 retention | Grounded records |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| grouped pages, 45k | 10 / 6 | low | 78.9 s | 125/240 (52.1%) | 27/34 (79.4%) | 98.3% |
| isolated pages, 45k | 15 / 6 | low | 86.4 s | 138/240 (57.5%) | 28/34 (82.4%) | 99.2% |
| isolated pages, 20k, targeted atomic scan | 20 / 6 | low | 108.1 s | 161/240 (67.1%) | 29/34 (85.3%) | 99.2% |
| isolated pages, 20k, targeted atomic scan | 20 / 6 | medium | 111.5 s | 180/240 (75.0%) | 32/34 (94.1%) | 98.5% |
| **same reader with higher safe fan-out** | **20 / 10** | **medium** | **96.9 s** | **187/240 (77.9%)** | **32/34 (94.1%)** | **99.3%** |

The fifth approach was 13% faster than the same medium-reasoning reader
at concurrency six while recovering seven more strict benchmark facts in this
run. Compared with the fastest grouped-page attempt, it costs 18 seconds but
recovers 62 additional facts and raises v1 retention by 14.7 percentage points.
The two remaining strict v1 misses are compound benchmark rows; inspection found
that at least one was represented as several narrower atomic records, so the
strict whole-quote metric is intentionally conservative.

### Contract simplification follow-up

The first five runs held the extraction schema fixed. Follow-up runs tested
field removal, model-facing names, the canonical profile-field restriction, and
reader concurrency while keeping the 20k/medium extraction pattern.

| Contract | Claim fields | Wall time | Manual recall | V1 retention | Records | Grounding |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| prior benchmark contract | 8 | 96.9 s | 187/240 (77.9%) | 32/34 (94.1%) | 605 | 99.3% |
| balanced atomic, permissive profile fields | 7 | 85.0 s | 184/240 (76.7%) | 32/34 (94.1%) | 583 | 99.3% |
| minimal fact/keywords/quote | 3 | 93.0 s | 198/240 (82.5%) | 32/34 (94.1%) | 883 | 99.4% |
| canonical names, detailed prompt | 7 | 74.8 s | 174/240 (72.5%) | 29/34 (85.3%) | 487 | 99.2% |
| canonical names, short prompt | 7 | 74.9 s | 172/240 (71.7%) | 30/34 (88.2%) | 488 | 99.0% |
| no keywords, permissive profile fields | 6 | 93.1 s | 194/240 (80.8%) | 33/34 (97.1%) | 763 | 99.7% |
| no scope, permissive profile fields | 6 | 79.0 s | 181/240 (75.4%) | 31/34 (91.2%) | 587 | 99.7% |
| exact production contract, concurrency 10 | 7 | 102.1 s | 195/240 (81.3%) | 32/34 (94.1%) | 606 | 98.7% |
| **exact production contract, concurrency 15** | **7** | **81.2 s** | **193/240 (80.4%)** | **31/34 (91.2%)** | **589** | **98.5%** |
| exact contract, low reasoning, concurrency 20 | 7 | 54.7 s | 182/240 (75.8%) | 32/34 (94.1%) | 483 | 98.3% |
| capped 32-fact reader, low, concurrency 20 | 7 | 36.5 s | 159/240 (66.3%) | 32/34 (94.1%) | 418 | 98.3% |

The production contract before this change had 11 fields; it added start date,
end date, and structured outcomes to the eight-field benchmark contract and had
not been run as an exact benchmark variant. This mismatch is why the follow-up
tested and then installed an explicit production contract rather than assuming
the earlier result transferred unchanged.

The minimal schema extracted more quotations, but it emitted far more records
and removed capability, ownership, maturity, and scope
classifications used by retrieval and requirement matching. It was rejected as
locally simpler JSON that would make the whole system noisier and less precise.

Removing keywords caused the model to compensate with 763 overlapping records
and reduced maturity accuracy from 81.8% to 73.8%. Removing scope saved about
six seconds but reduced strict v1 retention and removed a dimension explicitly
used by requirement matching. Ownership and maturity were retained because
matching must distinguish contribution from leadership and design from
production operation; the exact selected run classified maturity correctly on
83.9% of recovered manually labelled facts.

The balanced seven-field schema is retained. The two canonical-name validation runs showed
that asking the extractor for `action` and `toolsMethods` consistently caused
more compression than the literal `fact` and `keywords` names. The reader now
uses the benchmarked names and deterministically maps them to canonical action
and tools/methods fields after extraction.

It also removes reader-owned start/end dates, structured outcomes, and
limitations. Explicit dates, results, limitations, non-production boundaries,
and deprecated status must instead remain in the self-contained fact and exact
quote. Canonical expansion supplies stable empty defaults for the removed
fields, so downstream contracts remain compatible.
The runtime skill now describes only this balanced output rather than the old
rich notes/insights/unknowns contract.

### Parallel synthesis

V2 has a separate synthesis schema; v1 retains the original synthesis contract
for a real rollback path. The accuracy-oriented v2 first ran synthesis after
all readers, producing a 112.4-second total. The selected v2 instead starts a
compact role/profile call from the CV and portfolio overview at the same time as
the detailed page readers. Detailed claims and provenance still come only from
the complete reader wave.

The v2 synthesis model does not echo
`profileEvidence`, because exact evidence is already available from the reader
and is reattached deterministically after profile selection. Exact evidence
stays in its compact input so the result gateway can validate verbatim quotes
for any reported contradiction.

The model also no longer repeats search-vocabulary title aliases and problem
phrases. They are derived from the selected role families. Tool/method/standard
selection remains model-owned: an attempted deterministic-only variant was
faster, but admitted noisy terms such as project names and status words into
the search vocabulary. The remaining synthesis fields are not redundant:
profile drives constraints and applications; role families and semantic search
vocabulary drive discovery; unknowns and prohibited inferences constrain search
and matching; contradictions drive evidence review.

### End-to-end timing after acquisition

The final production analyzer—not a reader-only harness—was run against the
same frozen CV and website in a clean, isolated data root. Reader and compact
synthesis durations overlap; only the slower branch is on the critical path
before deterministic persistence.

| Stage | Time |
| --- | ---: |
| Detailed reader fan-out | 52.6 s |
| Compact role/profile synthesis, parallel | 27.2 s |
| Analyzer critical path | 52.8 s |
| Canonical verification and persistence | 4.0 s |
| **Total** | **56.8 s** |

The result contains 504 claims and 34 profile-evidence records. Readiness was
true with no review warnings. It recovered 183/240 manually adjudicated facts
(76.3%) and retained 33/34 facts visible in v1 (97.1%). The comparable local v1
run took 156.3 seconds and recovered 35/240 benchmark facts, making this measured
v2 run about 2.75 times faster while recovering 148 more benchmark facts.

The final cap was chosen from real production-runtime runs rather than from
reader-only timing:

| Production-runtime variant | End-to-end time | Claims | Manual recall | V1 retention |
| --- | ---: | ---: | ---: | ---: |
| uncapped completeness reader | 68.4 s | 666 | 197/240 (82.1%) | 32/34 (94.1%) |
| cap 36 | 60.3 s before process teardown | 506 | 183/240 (76.3%) | 33/34 (97.1%) |
| cap 32 | 51.5 s | 427 | 173/240 (72.1%) | 31/34 (91.2%) |
| **cap 34 (selected)** | **56.8 s** | **504** | **183/240 (76.3%)** | **33/34 (97.1%)** |

The selected report is stored at
`.local-run/experiments/evidence-v2-local-v1-20260805/live-v2-v11/report.json`.

The previous accuracy-oriented v2 is preserved with its code, reader outputs,
synthesis output, and timing under
`.local-run/experiments/evidence-v2-local-v1-20260805/preserved-v2-accuracy-112s`.
It recovered 193/240 facts but took 112.4 seconds. The selected sub-minute path
trades 4.2 percentage points of strict recall for 55.6 seconds of latency.
These are single-run latency measurements; model and provider latency are
stochastic, so 56.8 seconds is a measured result rather than a hard deadline.

## Earlier frozen benchmark (2026-08-01)

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

This earlier run selected the low-reasoning isolated reader at the time. The
current local-v1 experiment supersedes that selection because the larger,
current portfolio showed that page isolation, smaller dense-page chunks, and
medium reasoning materially improve matching-relevant recall at acceptable
latency.

The old rich reader contract asked the same call to produce atomic claims,
insights, 300-800 words of knowledge notes, unknowns, and prohibited inferences.
It was both the slowest fresh run and the least useful for matching: evidence was
compressed or placed into narrative fields instead of atomic claims. V2 now
uses a lean extraction contract and deterministically expands its claims into
the existing `SourceChunkNotes` boundary, including source insights and compact
knowledge notes. Explicit dates and measured outcomes remain in the
self-contained fact and exact quote rather than separate reader-owned fields.

The earlier v1 coverage experiment is still relevant: on this benchmark the
archived production first pass and its 23 coverage plus 7 repair calls both
recovered 105/262 facts. Those 30 extra calls added zero benchmark facts. The
canonical ledger retained 91/262, identifying canonicalization as a separate
recall boundary.

## Limitations

- Each fresh variant was run once; latency and model output are stochastic.
- Reader concurrency twenty assumes the provider can accept that fan-out; configure
  a lower v2 limit when necessary.
- The corpus covers one candidate's CV and portfolio, not every source type.
- The benchmark measures fact recall and quote grounding, not the quality of
  downstream role-family synthesis or final job matches.
- Synthesis variants were run once on one candidate; the preserved profile and
  vocabulary were inspected, but search and match quality still need their own
  downstream benchmark.
- Removed structured date/outcome/limitation fields remain visible in fact and
  exact quote, but their downstream classification is no longer independently
  populated by the reader.
- A grounding retry may add calls and latency when the first result contains an
  invalid quote; the selected run had two invalid records across 17 blocks.
