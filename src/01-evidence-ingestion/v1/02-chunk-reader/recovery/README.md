# Bounded reader recovery

Recovery is local to one failed chunk. The initial extraction is checked by an
independent coverage call. If it fails, a separate repair call receives the
immutable chunk, current extraction, and exact actionable findings. It returns
only a delta; deterministic code filters unsupported quotations, applies the
patch without replacing unrelated evidence, and sends the merged extraction to
a fresh coverage call.

The loop permits at most three repair rounds and four coverage checks. A failed
fourth coverage check terminates as `needs_review`. Runtime, tool-policy, or
schema failures terminate as `analysis_failed`. These fixed limits prevent
silent infinite loops and make call cost predictable.

The reader executes sequential batches of 24 chunks. A run analyzes at most 48
chunks by default (two batches), with a database-backed administrator setting
or `ROLEGAIN_MAX_EVIDENCE_CHUNKS` fallback controlling the run allowance. The
hard maximum is 240 chunks. When a source exceeds the allowance, completed
chunks are synthesized and persisted, incomplete sources are marked
`needs_review`, and the candidate can continue using the finished evidence.
