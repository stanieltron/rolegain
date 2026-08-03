# Match

[Repository map](../../README.md) |
[Top-level facade](./opportunity-researcher.ts) |
[Previous pipeline](../02-search/README.md) |
[Next pipeline](../04-application-preparation/README.md)

Match consumes live validated opportunities and the exact canonical evidence
run, including its small evidence knowledge base. The knowledge index routes
broad vacancy wording to bounded topic and source context; canonical claims
remain the only scoring authority. Match scores requirement fit, independently
verifies and repairs the matrix in v1, or uses the calibrated one-pass matcher
in v2, then inspects employer application forms for selected opportunities. It
does not discover jobs and it does not draft application answers.

V1 is the default. Set `ROLEGAIN_MATCH_VERSION=v2` for a matching-only
experiment. The `npm run dev:v2`, `npm run start:v2`, and
`npm run dev:diagnostic:v2` launchers select matching v2, evidence ingestion
v2, and search v2 together. See the
[v1](./v1/README.md) and [v2](./v2/README.md) guides.

## Architecture

| Folder | Responsibility | Public surface |
|---|---|---|
| [`v1/`](./v1/README.md) | Version-pinned multi-call requirement matching | `index.ts`, `contracts.ts`, `schemas.ts`, `README.md` |
| [`v2/`](./v2/README.md) | Version-pinned calibrated one-pass matching | `index.ts`, `contracts.ts`, `schemas.ts`, `README.md` |
| [`shared/01-requirement-matching/`](./shared/01-requirement-matching/README.md) | Shared deterministic citation, scoring, and call mechanics | Internal shared implementation |
| [`02-application-inspection/`](./02-application-inspection/README.md) | Navigate employer application paths and verify observed form schemas | Hybrid |
| [`orchestration/`](./orchestration/README.md) | Stream validated vacancies into bounded matching workers | Deterministic |
| [`opportunity-researcher.ts`](./opportunity-researcher.ts) | Compatibility facade that composes search plus match for product flows | Deterministic composition |

The reusable search/match types and deterministic helpers live in
[`../search-match-shared/`](../search-match-shared/README.md).

## Public Runners

`npm run stage -- match.requirements` routes already validated jobs through the
evidence knowledge index and matches them against the resulting canonical claim
subset.

`npm run stage -- applications.inspect-form` maps employer application forms
for already matched opportunities.

The product facade still offers `LiveOpportunityResearcher.run()` for the full
search-through-form-inspection path, but the source layout and stage registry
keep search and match as separate numbered flows.

## LLM Calls

V1 uses all four requirement-matching calls below. V2 uses only
`match.requirements`; application-inspection calls are unchanged.

| Call id | Location | Purpose |
|---|---|---|
| `match.requirements` | `shared/01-requirement-matching/llm-calls/01-requirement-matching/`; version schemas in `v1/schemas.ts` and `v2/schemas.ts` | Initial requirement matrix per validated job |
| `match.tier2-evidence` | `shared/01-requirement-matching/llm-calls/02-tier2-matching/` | V1 bounded evidence escalation |
| `match.verification` | `shared/01-requirement-matching/llm-calls/03-match-verification/` | V1 fresh review |
| `match.repair` | `shared/01-requirement-matching/llm-calls/04-match-repair/` | V1 bounded repair |
| `application.navigate` | `02-application-inspection/llm-calls/01-application-navigation/` | Reveal an employer form when deterministic navigation is insufficient |
| `application.field-map` | `02-application-inspection/llm-calls/02-application-field-mapping/` | Map observed fields into the application draft schema |
| `application.schema-verify` | `02-application-inspection/llm-calls/03-application-schema-verification/` | Fresh audit of the mapped form schema |

## Handoff

Match hands selected matched opportunities, mapped `ApplicationDraft[]`,
failures, and the exact evidence-run id to
[`04-application-preparation`](../04-application-preparation/README.md).
