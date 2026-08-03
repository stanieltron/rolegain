# Expand one source batch

`expandOneVacancySourceBatch(input)` reads exactly one saved source cursor. It
captures one public page, extracts concrete vacancy links, applies the canonical
candidate search-plan filter, removes already-seen URLs, and returns child
vacancy leads plus the next cursor.

It does not validate, match, or score children. Those leads enter the same
vacancy pipeline as direct web-search results. This boundary is intentionally
callable by itself for source-adapter tests and targeted inspections.
