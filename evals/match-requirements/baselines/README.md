# Baselines

Store an approved run's `summary.json`, `release-gate.json`, `run-config.json`,
`trials.jsonl`, and corpus version here only after label adjudication and
reviewer approval. The trial records are required for paired task-level
comparison. Name directories as `<corpus-version>/<model>/<date>`.

Do not automatically promote the latest run: a baseline is an accepted
reference, not merely the most recent output. Use
`npm run eval:match-requirements:compare` to compare a candidate summary.
