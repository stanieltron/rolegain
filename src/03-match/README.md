# Match

[Repository map](../../README.md) |
[Top-level facade](./opportunity-researcher.ts) |
[Previous pipeline](../02-search/README.md) |
[Next pipeline](../04-application-preparation/README.md)

Match consumes live validated opportunities and the exact canonical evidence
run. It scores requirement fit, independently verifies and repairs the match
matrix, then inspects employer application forms for selected opportunities.
It does not discover jobs and it does not draft application answers.

## Architecture

| Folder | Responsibility | Execution |
|---|---|---|
| [`01-requirement-matching/`](./01-requirement-matching/README.md) | Build, verify, repair, and score requirement-to-evidence matrices | Hybrid |
| [`02-application-inspection/`](./02-application-inspection/README.md) | Navigate employer application paths and verify observed form schemas | Hybrid |
| [`orchestration/`](./orchestration/README.md) | Stream validated vacancies into bounded matching workers | Deterministic |
| [`opportunity-researcher.ts`](./opportunity-researcher.ts) | Compatibility facade that composes search plus match for product flows | Deterministic composition |

The reusable search/match types and deterministic helpers live in
[`../search-match-shared/`](../search-match-shared/README.md).

## Public Runners

`npm run stage -- match.requirements` matches already validated jobs against the
canonical evidence ledger.

`npm run stage -- applications.inspect-form` maps employer application forms
for already matched opportunities.

The product facade still offers `LiveOpportunityResearcher.run()` for the full
search-through-form-inspection path, but the source layout and stage registry
keep search and match as separate numbered flows.

## LLM Calls

| Call id | Location | Purpose |
|---|---|---|
| `match.requirements` | `01-requirement-matching/llm-calls/01-requirement-matching/` | Initial requirement matrix per validated job |
| `match.tier2-evidence` | `01-requirement-matching/llm-calls/02-tier2-matching/` | Bounded evidence escalation for unresolved rows |
| `match.verification` | `01-requirement-matching/llm-calls/03-match-verification/` | Fresh review after initial match and after repair |
| `match.repair` | `01-requirement-matching/llm-calls/04-match-repair/` | One bounded repair for verifier-rejected jobs |
| `application.navigate` | `02-application-inspection/llm-calls/01-application-navigation/` | Reveal an employer form when deterministic navigation is insufficient |
| `application.field-map` | `02-application-inspection/llm-calls/02-application-field-mapping/` | Map observed fields into the application draft schema |
| `application.schema-verify` | `02-application-inspection/llm-calls/03-application-schema-verification/` | Fresh audit of the mapped form schema |

## Handoff

Match hands selected matched opportunities, mapped `ApplicationDraft[]`,
failures, and the exact evidence-run id to
[`04-application-preparation`](../04-application-preparation/README.md).
