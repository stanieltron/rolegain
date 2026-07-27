# Gold-label adjudication protocol

The benchmark currently uses machine-reviewed labels. Complete this process
before setting any case to `human_reviewed`.

1. Two reviewers independently inspect only the vacancy text, canonical claims,
   routed knowledge pages when present, and proposed gold rows. They do not
   inspect model outputs.
2. For every atomic requirement, each reviewer records category, acceptable
   match classes, allowed claim keys, criticality, and rationale.
3. Exact agreement is required for direct, unsupported, category, and citation
   labels. Adjacent disagreements are resolved by a third reviewer using the
   ownership/maturity/scope/duration rules below.
4. Calculate agreement before resolution: requirement extraction F1, category
   accuracy, match-class weighted Cohen's kappa, and citation-set Jaccard.
5. Resolve disagreements in a dated adjudication record. Changing a gold label
   increments the corpus version and invalidates incompatible baselines.
6. Set `labelStatus: "human_reviewed"` only after both the independent labels
   and resolution record are stored outside model-generated artifacts.

Decision rules:

- `explicit`: the cited claim directly establishes every material qualifier.
- `strong_adjacent`: capability is highly transferable but one non-critical
  tool, platform, or context differs.
- `weak_adjacent`: related evidence exists but a material qualifier, scope,
  maturity, ownership, duration, or context is absent.
- `unsupported`: no claim provides defensible positive support.
- `contradicted`: canonical evidence affirmatively conflicts with the
  requirement.
- A weakly supported claim can never justify `explicit`.
- Numeric minimums are not satisfied by lower or unspecified quantities.
- Team activity is not individual ownership without attribution.
- Citations must be both canonical and relevant to that specific requirement.
- Knowledge-page prose may explain why a claim is relevant, but it cannot
  satisfy a requirement without a linked canonical claim and exact citation.
- A retrieval alias may route broad wording to a page; it must not upgrade the
  claim's ownership, maturity, scope, duration, outcomes, or support status.
