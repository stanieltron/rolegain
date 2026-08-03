# Vacancy-source expansion

[Contracts](./contracts.ts) · [Persistent inventory](./inventory/README.md) ·
[Expand one batch](./expand-one-batch/README.md) ·
[Browser-agent fallback](./browser-agent/README.md) ·
[Run or resume one source](./run/README.md)

Initial web-search output is classified as either a concrete `vacancy` or a
`vacancy_search` source. Concrete vacancies enter validation immediately.
Sources enter this bounded expansion stage and emit concrete child vacancies
into that same validation queue.

Checkpoints live under the candidate and therefore survive search runs. A later
next-five request loads saved sources, refreshes their newest page when stale,
and continues the saved pagination frontier alongside fresh web discovery.
Interactive pages without ordinary pagination use the bounded browser-agent
fallback. Its semantic action recipe is checkpointed with the source.
