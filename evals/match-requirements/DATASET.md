# Dataset card

## Purpose

Measure exhaustive, evidence-grounded employer-requirement matching while
penalizing omissions, phantom requirements, evidence leakage, unsupported
seniority/scope/duration claims, and repair regressions.

## Composition

- Version: `3.1.0`
- Cases: 52
- Atomic gold requirements: 110
- Development/test split: 26/26
- Sources: synthetic candidate claims, evidence-wiki routes, and vacancy text
- Personal data: none
- Label status: machine-reviewed, awaiting independent human adjudication

Every case supplies exact vacancy sections, canonical evidence claims, allowed
match classes, requirement-specific allowed claim keys, criticality, aliases,
and a written gold rationale. Some cases also contain untrusted instruction text
or distractor evidence. Knowledge-routing cases add synthetic retrieval terms
and narrative to the generated capability page after canonical evidence
persistence. This tests the index/page contract while canonical claims remain
the only valid citations.

## Coverage

| Family | Cases | Main risk |
|---|---:|---|
| Direct | 8 | False negatives on exact support |
| Missing | 5 | Invented support and softened gaps |
| Adjacent | 8 | Tool/domain dialect inflation |
| Scope/ownership | 7 | Contributor-to-owner or prototype-to-production inflation |
| Duration/quantity | 4 | Ignoring numeric minimums |
| Evidence quality | 5 | Promoting weak or ambiguous claims |
| Requirement extraction | 5 | Omission, duplication, category, and atomicity errors |
| Adversarial | 4 | Following instruction-shaped vacancy data |
| Citation integrity | 4 | Valid-looking but requirement-wrong citations |
| Knowledge routing | 2 | Missing deep evidence for broad or cross-domain requirement language |

## Splits and leakage

The development split may be used for prompt and grader iteration. The test
split should be run only for comparison/release candidates. Both are visible in
the repository, so the test split is a regression holdout rather than a secret
anti-contamination set. Do not paste test cases into production prompts.

## Limitations

Synthetic wording cannot reproduce the full distribution of real vacancies or
candidate histories. Alias-based row alignment can still need adjudication when
a model paraphrases aggressively. Allowed adjacent classes intentionally admit
more than one defensible judgment. Runtime measurements depend on service tier,
parallel load, caching, and network conditions. Add redacted real-world cases as
a separate protected corpus before making high-stakes deployment claims.

The two knowledge-routing cases validate deterministic page selection and
claim exposure, not semantic retrieval completeness. They do not establish
recall across every profession, language, or evidence shape.

This dataset is deliberately limited to the requirement-matching decision
boundary. Its coverage counts must not be interpreted as coverage of the
complete job-discovery or application workflow.
