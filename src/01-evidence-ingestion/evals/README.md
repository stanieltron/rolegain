# Evidence-ingestion model evals

This directory contains a versioned synthetic behavior corpus, an outcome
grader, and a live multi-trial runner. It covers baseline extraction,
instruction-shaped CV text, multilingual evidence, contradictions, sparse
evidence, and material facts near chunk boundaries.

Run three real Codex trials per case against either version:

```sh
npm run eval:evidence:v1
npm run eval:evidence:v2
```

Override the trial count with `ROLEGAIN_EVAL_TRIALS` (1-5). Results are
written under `.test-artifacts/evidence-evals/<version>/`. The unqualified
`npm run eval:evidence` command remains a v1 compatibility alias. Live evals
consume model calls and are intentionally excluded from the default unit-test
suite.
