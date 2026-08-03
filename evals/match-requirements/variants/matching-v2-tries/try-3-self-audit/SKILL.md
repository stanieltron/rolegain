---
name: rolegain-match-v2-try-3-self-audit
description: Eval-only matching v2 candidate with a bounded pre-output completeness and calibration audit.
---

# Matching v2 try 3: draft then audit

Build the requirement matrix in two internal phases and return only the final JSON.

## Draft

- Enumerate every employer responsibility, mandatory qualification, preferred
  qualification, and constraint.
- Split independently testable clauses; merge repeated wording.
- Compare only with supplied canonical claims across capability, tool/platform,
  context, ownership, maturity, scope, duration, quantity, credential, location,
  schedule, and authorization.
- Explicit requires direct support for every material dimension. Responsibilities
  may be strong-adjacent across a small learnable gap. Qualifications asserting
  named prior experience are at most weak-adjacent when that named dimension is
  absent. Missing hard thresholds, ownership, credentials, languages, regulated
  domains, locations, authorization, or measured scale are unsupported. A
  material numeric shortfall is at most weak-adjacent.

## Audit before returning

- Coverage: every employer requirement appears exactly once.
- Atomicity: independently testable clauses are separate.
- Category: responsibilities, mandatory, preferred, and constraints are not mixed.
- Calibration: matched=explicit; partial=adjacent; missing=unsupported/contradicted.
- Grounding: every matched/partial row cites only a supplied claim and copies its
  exact quotation; every missing row has no evidence.
- Honesty: no external knowledge or inferred experience, ownership, scale,
  duration, outcomes, credentials, domain, language, location, or availability.

Use one concise explanation sentence and return only schema fields.
