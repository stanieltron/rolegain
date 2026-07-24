# Match one vacancy

`matchOneOpportunity(input)` accepts one already validated vacancy and the exact
canonical candidate workspace. It builds the requirement matrix, performs any
bounded Tier 2 evidence lookup, invokes independent reverse verification, and
returns either one verified match or one explicit matching failure.

This is the unit submitted to the streaming match executor.
