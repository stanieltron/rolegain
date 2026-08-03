# Match one vacancy

`matchOneOpportunity(input)` accepts one already validated vacancy and the exact
canonical candidate workspace. V1 builds the matrix, performs bounded Tier 2
lookup, and invokes independent reverse verification. V2 builds the calibrated
lean matrix once and proceeds through deterministic citation validation and
scoring. Both return either one accepted match or one explicit matching failure.

The optional `version` input overrides `ROLEGAIN_MATCH_VERSION` for evals and
inspection. Product `*:v2` launchers select matching v2 together with evidence
ingestion v2 and search v2.

This is the unit submitted to the streaming match executor.
