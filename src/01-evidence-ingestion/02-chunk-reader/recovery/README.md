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

The stage also bounds the total source chunks with
`ROLEGAIN_MAX_EVIDENCE_CHUNKS` (default 24, hard range 1–64). Exceeding the
budget terminates as `needs_review` before any model call starts.
