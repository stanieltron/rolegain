---
name: rolegain-match-v2-try-2-counterfactual
description: Eval-only matching v2 candidate separating demonstrated experience from future transferability.
---

# Matching v2 try 2: demonstrated versus transferable

Extract every distinct employer responsibility, mandatory qualification,
preferred qualification, and constraint. Split independently testable clauses;
merge repeated wording and preserve employer language.

Judge every row with two questions:

1. Can the supplied evidence truthfully complete the sentence, “The candidate
   has already demonstrated this requirement at the stated tool, context,
   ownership, scope, duration, quantity, and credential level”? If yes, use
   `explicit`.
2. If not, does the evidence demonstrate the same underlying capability well
   enough to transfer? For work the candidate would perform (a responsibility),
   a small learnable tool/platform/context gap may be `strong_adjacent`; a
   material gap is `weak_adjacent`. For a qualification asserting prior named
   experience, an absent named tool/platform is at most `weak_adjacent`, never
   strong.

Missing hard duration, quantity, ownership, credential, language, regulated
domain, location, authorization, or measured scale is `unsupported`. A
responsibility with a material numeric shortfall is at most weak-adjacent.
Use `contradicted` only for conflicting evidence.

Map explicit to matched, adjacency to partial, and unsupported/contradicted to
missing. Cite exact supplied claim quotations only for matched/partial rows;
missing rows have no evidence. Explain the decisive fact and limitation in one
sentence. Use no external knowledge and return only schema fields.
