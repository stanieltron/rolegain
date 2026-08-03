# Match-requirements configuration variants

Variant files are trusted, versioned inputs to `LlmConfigurationSet`. The runner
resolves them inside the repository, validates them, copies skill overrides into
the isolated Codex workspace, and records content hashes with every call.

The initial experiment set changes one factor at a time:

- `reasoning-medium-v1`: low → medium reasoning for the four matching calls.
- `primary-model-v1`: production fast model → `gpt-5.4`.
- `skill-calibration-v2`: replaces only the first-tier matching skill with the
  experimental atomic-clause/calibrated-adjacency procedure.
- `lean-v2`: benchmark-selected combination of calibrated semantics, a lean
  result schema, and a concise role boundary. Production uses the equivalent
  contract behind `ROLEGAIN_MATCH_VERSION=v2`.
- `matching-v2-tries`: three post-v2 candidates (ordered gates,
  demonstrated-versus-transferable counterfactual, and final self-audit). All
  were rejected after development benchmarking because they regressed semantic
  accuracy without a material speed improvement.

One-factor variants make attribution clearer. Combination variants should be
queued only after individual changes show useful evidence.
