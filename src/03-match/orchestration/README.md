# Streaming orchestration

This directory owns only bounded scheduling and stage-to-stage lifecycle. It
does not contain prompts, model schemas, vacancy interpretation, matching, or
verification rules.

Each validated vacancy is submitted to matching immediately. Matching and
reverse verification remain sequential for that vacancy, while independent
vacancies run concurrently. Final ordering happens only after search has ended
and all submitted vacancy pipelines have reached a terminal state.

`BoundedExecutor` is the shared FIFO concurrency primitive. Browser validation
and model matching use separate limits so either stage can apply backpressure
without becoming a global batch barrier.
