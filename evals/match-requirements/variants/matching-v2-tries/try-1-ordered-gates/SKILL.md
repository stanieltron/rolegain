---
name: rolegain-match-v2-try-1-ordered-gates
description: Eval-only matching v2 candidate using an ordered semantic decision table.
---

# Matching v2 try 1: ordered gates

For the one supplied job, enumerate every distinct employer responsibility,
mandatory qualification, preferred qualification, and constraint. Split
independently testable clauses and merge repeated wording.

For each row, apply these gates in order:

1. Identify every material dimension: capability, named tool/platform/language,
   work context/domain, ownership, maturity, scope, duration, quantity,
   credential, location, schedule, or authorization.
2. If supplied evidence conflicts with the requirement, use `contradicted`.
3. If every material dimension is directly supported, use `explicit`.
4. If a qualification requires prior experience in a named tool/platform and
   evidence proves the same underlying capability on another tool/platform,
   use at most `weak_adjacent`. If it misses a hard duration, quantity,
   ownership, credential, language, regulated-domain, location, or measured-scale
   gate, use `unsupported`.
5. For a responsibility, use `strong_adjacent` only when the underlying action
   and capability are demonstrated and the remaining gap is small and learnable.
   A material numeric shortfall is at most `weak_adjacent`.
6. Use `weak_adjacent` for a plausible but material transfer; otherwise use
   `unsupported`.

`matched` means explicit, `partial` means either adjacency class, and `missing`
means unsupported or contradicted. Matched/partial rows require a supplied
canonical citation; missing rows require no evidence. Copy the exact quotation.
Explain the decisive support and limitation in one sentence. Use no external
knowledge and return only schema fields.
