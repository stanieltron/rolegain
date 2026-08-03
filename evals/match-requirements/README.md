# Match Requirements Evals

This eval package measures the requirement-matching production boundary in two
layers:

1. Individual LLM call components.
2. The complete match flow.

The goal is not just to score a model. The eval must identify where the flow
failed and produce enough evidence to improve the matching prompt, skill,
schema, retrieval, verifier, repair step, or dataset labels.

## Layout

```text
evals/match-requirements/
  v1/
  v2/
  ADJUDICATION.md
  DATASET.md
  README.md
  config/
    experiments.json
  src/
    cli/
    config/
    dataset/
    graders/
    harness/
    improvement/
  variants/
```

Generated run artifacts and mutable variant state live under
`.agent-runtime/match-requirements/`, not in this source directory.

## Suites

- `match.requirements.component`: runs only the first production
  `match.requirements` call and grades extraction, category, match class, and
  requirement-specific citations. Its input includes the same bounded
  `knowledgeRoutesByJob` packet as production.
- `match.tier2.component`: starts from an unresolved gold matrix, runs only
  `match.tier2-evidence`, and grades bounded evidence recovery.
- `match.verification.component`: runs `match.verification` against clean or
  single-defect seeded matrices and grades verdict, defect recall, clean
  specificity, and targeted findings.
- `match.repair.component`: runs verifier plus one bounded `match.repair`
  attempt against seeded defective matrices and grades repaired output.
- `match.full-flow`: runs the selected production chain. V1 includes first pass,
  Tier 2, independent verification, bounded repair, and fresh verification. V2
  uses its calibrated first pass only. Both retain deterministic citation
  filtering and final mapping. Set the version environment explicitly when
  comparing full-flow runs.

## Dataset

The synthetic v3.1 corpus contains 52 cases and 110 atomic gold requirements.
Families cover direct support, honest missing evidence, adjacent capabilities,
scope/ownership, duration/quantity, evidence quality, extraction errors,
adversarial vacancy text, citation integrity, and knowledge routing for broad
requirements. The routing cases cover both software and industrial electrical
work.

The labels are still `machine_reviewed`. The release gate intentionally fails
until independent human adjudication is complete. See `DATASET.md` and
`ADJUDICATION.md`.

## Running

Run the full production eval:

```sh
npm run eval:match-requirements:v1 -- \
  --models gpt-5.4-mini,gpt-5.4 \
  --trials 3 \
  --concurrency 6
```

Run the benchmark-selected v2 component and full-flow suites with:

```sh
npm run eval:match-requirements:v2 -- \
  --models gpt-5.4-mini,gpt-5.4 \
  --trials 3 \
  --concurrency 6
```

The v2 default excludes Tier-2, verification, and repair component suites
because they are not part of the v2 production path. Supply `--suites`
explicitly only when auditing those shared calls independently.

Run one component suite:

```sh
npm run eval:match-requirements -- \
  --models gpt-5.4-mini \
  --suites match.requirements.component \
  --split development
```

Compare a candidate run to a baseline:

```sh
npm run eval:match-requirements:compare -- \
  .agent-runtime/match-requirements/runs/baseline \
  .agent-runtime/match-requirements/runs/candidate
```

Analyze failures from a run:

```sh
npm run eval:match-requirements:analyze -- \
  .agent-runtime/match-requirements/runs/candidate
```

The analyzer writes `failure-analysis.json` into the run directory and clusters
failures by suite, family, error type, case, and row-level grader reason.

## Improvement Loop

Use this loop for matching upgrades:

1. Run a targeted component suite on the development split.
2. Inspect `failure-analysis.json` and the per-trial `calls.json`,
   `grade.json`, and `gold.json`.
3. Make one-factor changes: prompt/skill, schema/gateway, knowledge-index
   routing, Tier 2 retrieval, verifier rubric, repair instructions, or dataset
   labels.
4. Run the same development suite and compare to baseline.
5. If non-inferior or improved, run `match.full-flow` on development.
6. If still clean, run all suites on the test split.
7. Promote only after release gates pass or after explicitly accepting a
   diagnostic baseline.

Planned source-owned experiments live in `config/experiments.json`. Runtime
queue and result state are materialized in `.agent-runtime/match-requirements`
when `npm run eval:match-requirements:next` is used.

## Release Gate

Release eligibility requires:

- all five suites selected,
- all scoped cases covered,
- at least three trials per case,
- compatible runtime,
- 100% human-reviewed labels,
- component, full-flow, verifier, repair, operational, citation, critical
  safety, reliability, instability, and confidence-bound thresholds passing.

Synthetic labels and visible test cases make this a strong regression benchmark,
not a high-stakes deployment benchmark, until human adjudication and a protected
redacted real-world corpus are added.
