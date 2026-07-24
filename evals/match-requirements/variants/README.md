# Match-requirements configuration variants

Variant files are trusted, versioned inputs to `LlmConfigurationSet`. The runner
resolves them inside the repository, validates them, copies skill overrides into
the isolated Codex workspace, and records content hashes with every call.

The initial experiment set changes one factor at a time:

- `reasoning-medium-v1`: low → medium reasoning for the four matching calls.
- `primary-model-v1`: production fast model → `gpt-5.4`.
- `skill-calibration-v2`: replaces only the first-tier matching skill with the
  experimental atomic-clause/calibrated-adjacency procedure.

One-factor variants make attribution clearer. Combination variants should be
queued only after individual changes show useful evidence.
