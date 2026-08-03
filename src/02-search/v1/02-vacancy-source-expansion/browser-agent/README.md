# Vacancy-source browser agent

[Run one interactive source](./run/index.ts) ·
[Action policy](./policy.ts) · [Page observation](./observe.ts) ·
[Inspectable model call](./llm-calls/01-source-navigation/index.ts)

This is the fallback for listing pages that expose more vacancies through
scrolling or a safe continuation control instead of a normal pagination URL.
The model receives a frozen observation and selects one bounded action. The
backend independently validates and executes that action.

The checkpoint stores a run-length-encoded semantic replay recipe and observed
vacancy URLs. A later next-five run reopens the source, deterministically
replays actions such as `scroll × 4` or `load more × 3`, and then asks for new
actions. It does not rely on a saved pixel position or a month-old browser tab.

Only same-host continuation controls are allowed. Applying, submitting,
authenticating, registering, accepting terms, and leaving the source host are
prohibited. Concrete URLs emitted by this component remain untrusted and enter
the ordinary vacancy-validation pipeline.

Bounds are configurable with:

- `ROLEGAIN_SOURCE_AGENT_STEPS_PER_RUN` — new model-selected actions per
  source batch, default `8`, maximum `20`;
- `ROLEGAIN_SOURCE_AGENT_MAX_REPLAY_ACTIONS` — deterministic replay depth,
  default `120`, maximum `500`;
- `ROLEGAIN_SOURCE_BROWSER_AGENT=disabled` — disable this fallback while
  retaining ordinary pagination and source checkpoints.
