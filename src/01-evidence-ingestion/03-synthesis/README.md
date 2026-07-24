# 03 — Evidence synthesis

[Back to Evidence Ingestion](../README.md) · [Implementation](./index.ts) ·
[Synthesis call contract](./llm-calls/01-evidence-synthesis/index.ts)

This stage performs the one cross-source reducer call. Reader-produced claims
remain authoritative; synthesis creates the candidate-wide interpretation used
by search.

## Entry point

`synthesizeCandidateEvidence({ codex, cwd, workspace, model, reading, message, onProgress })`

## Internal flow

1. Publish `synthesizing` progress after all reader calls have joined.
2. Start a fresh, isolated Codex thread.
3. Build a prompt from the current workspace and complete ordered source notes.
4. Parse the structured result.
5. Attach the reader-owned `sourceInsights` instead of allowing synthesis to
   rewrite source-level claims.

## LLM boundary

Call id: `evidence.synthesis`

The synthesis LLM returns:

- candidate profile facts;
- exact reader-owned provenance for every selected source-derived profile value;
- candidate-wide unknowns and contradictions;
- prohibited inferences;
- evidence-backed role families;
- reusable search vocabulary.

It cannot browse or read repository files. A one-chunk CV still goes through
this stage so downstream code always receives the same contract.

Role-family cardinality is evidence-driven (`0–8`), not a target. Sparse
evidence may therefore return no role family and fail the deterministic search
readiness gate instead of being stretched into invented roles.

## Output

`CandidateAnalysisResult`, containing the synthesis thread id, synthesized
candidate model, and unchanged reader-produced source analyses.

## Failure behavior

Malformed output or an LLM failure aborts the flow. No profile facts or
canonical evidence run are persisted.

## Planned repair responsibility

Stage 03 should not decide by itself whether the complete run needs repair.
The planned recovery loop starts after Stage 04 has audited the canonical
evidence and returned a non-ready result. When Stage 04 classifies a blocker as
synthesis-owned, it may request a bounded targeted repair here. The repaired
candidate model must then pass through every Stage 04 check again.

This repair may change synthesis-owned fields only. Missing or unsupported
reader-owned claims must return to Stage 02 reading or coverage repair;
unreadable, empty, or genuinely absent evidence remains `needs_review`.

## Next stage

[04 — Verification](../04-verification/README.md) deterministically audits and
publishes the result.
