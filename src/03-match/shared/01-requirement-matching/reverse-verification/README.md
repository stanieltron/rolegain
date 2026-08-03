# Reverse-verify one match

`reverseVerifyOneMatch(input)` is a directly callable, fresh-context verifier
for one vacancy assessment. Supply the original validated vacancy, proposed
requirement matrix, and canonical candidate citation ledger.

It checks requirement completeness, employer-section grounding, exact candidate
citations, unsupported promotion, scope inflation, and feasibility. It returns
only `pass` or `needs_repair` with concrete findings; it does not silently repair
or score the match.

This is part of the v1 standard path and remains directly callable for audits.
The benchmark-selected v2 standard path omits semantic reverse verification and
keeps deterministic citation and scoring checks instead.
