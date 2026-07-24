# Dataset card

## Purpose

Measure exhaustive, evidence-grounded employer-requirement matching while
penalizing omissions, phantom requirements, evidence leakage, unsupported
seniority/scope/duration claims, and repair regressions.

## Composition

- Version: `2.0.0`
- Cases: 50
- Atomic gold requirements: 104
- Development/test split: 25/25
- Sources: synthetic candidate claims and synthetic vacancy text
- Personal data: none
- Label status: machine-reviewed, awaiting independent human adjudication

Every case supplies exact vacancy sections, canonical evidence claims, allowed
match classes, requirement-specific allowed claim keys, criticality, aliases,
and a written gold rationale. Some cases also contain untrusted instruction text
or distractor evidence.

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

This dataset is deliberately limited to the requirement-matching decision
boundary. Its coverage counts must not be interpreted as coverage of the
complete job-discovery or application workflow.
