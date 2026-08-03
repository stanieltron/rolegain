# Run one vacancy source

`runVacancySource(input)` is the complete independently callable continuation
loop for one source. It registers or loads the durable checkpoint, refreshes the
head when stale, resumes the saved frontier, emits concrete child vacancies,
and saves progress after every page.

For an interactive listing, the same checkpoint also stores browser-agent
replay steps and observed vacancy URLs. Standard pagination remains the first
choice; the agent is invoked only when the page signals scrolling or a
load-more continuation without an ordinary next-page URL.

The run is bounded by candidate and page budgets. It never sends a source page
to matching and never crawls indefinitely. Emitted children must still pass the
normal vacancy validation, match, and reverse-verification pipeline.
