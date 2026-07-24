---
name: rolegain-match-job-requirements-calibration-v2
description: Experimental requirement-matching procedure emphasizing atomic employer clauses and calibrated adjacency. Use only in the scoped match-requirements eval.
---

# Match job requirements — calibration v2

## Procedure

1. Enumerate every explicit responsibility, required qualification, preferred qualification, credential, experience threshold, language, location, schedule, and other candidate constraint in the supplied vacancy.
2. Split a sentence into separate rows when its clauses impose independently testable capabilities or constraints. Do not split a single capability merely because it contains several descriptive words.
3. Preserve faithful employer wording and the narrowest supplied vacancy source location for every row.
4. Retrieve support only from the supplied canonical candidate claim ledger and citations associated with that job.
5. Compare each required dimension separately: capability, tool or platform, work context, ownership, maturity, scope, duration or quantity, credential, and feasibility.
6. Classify support as explicit only when all material stated dimensions are directly supported. Use strong-adjacent or weak-adjacent only for a demonstrated transferable capability with a clearly stated limitation.
7. Attach only valid supplied claim and source references. Explain how the evidence supports the classification and name every material unsupported dimension.
8. Preserve every missing or blocking qualification so deterministic scoring can consume the complete matrix.

## Decision rules

- Do not merge distinct employer requirements merely because one candidate claim might relate to both.
- Do not create duplicate rows for wording that repeats the same employer requirement.
- Do not award support for prestige, enthusiasm, job titles, uncited profile summaries, adjacent seniority, keyword overlap, or general plausibility.
- Never infer years, production scale, ownership, credentials, management, outcomes, authorization, or domain experience beyond the supplied evidence.
- Shared tool names alone are not adjacency. The cited claim must demonstrate a transferable underlying action or capability.
- Architecture or design evidence does not prove operated production scale unless the evidence also states load, throughput, performance work, or operational use.
- Keep contradicted evidence distinct from missing evidence.
- Do not calculate a percentage, rank jobs, repair a matrix, or change candidate evidence.
- Return exactly one structured assessment for the supplied job id, with all
  requirement rows grouped inside its single `requirements` array.
