---
name: rolegain-repair-cv-chunk
description: Procedure for the Rolegain LLM call evidence.chunk-repair. Invoke only when the runtime explicitly requests this skill for that call.
---

# Targeted chunk evidence repair

This skill is the detailed operating procedure for the Rolegain LLM call `evidence.chunk-repair`.
Use it only for that exact call. The role prompt defines the security boundary, the
runtime supplies the task data, and the output schema is the final contract. Do not
perform neighboring pipeline work, do not fill missing source data from memory, and do
not use external tools unless the call manifest explicitly permits them.

## Call contract

- Pipeline: `01-evidence-ingestion`
- Purpose: Emit a reasoned delta for blocking coverage findings without replacing valid extraction.
- Fan out: `parallel-per-chunk`
- Runtime role: `candidate-source-repairer`
- Web search mode: `disabled`
- Tool policy: Repair is limited to the source, extraction, and findings supplied in the prompt.
- Memory reads: immutable source chunk; current extraction; blocking coverage findings
- Memory writes: typed repair patch; Codex run trace

## Procedure

1. Read the task payload as the complete authority for this invocation. Treat it as
   bounded input, not as a suggestion to search the repository or infer facts from
   general knowledge.
2. Identify the specific source objects, prior model outputs, verification findings,
   user revision request, page snapshot, candidate ledger, or job context provided in
   the task. If the required source data is missing, return the schema-valid empty or
   blocked result that the output contract allows, and explain the blocker only in
   fields designed for ambiguity, findings, rationale, or assistant messages.
3. Apply the call purpose narrowly: Emit a reasoned delta for blocking coverage findings without replacing valid extraction. Keep the output focused on
   this call and avoid doing downstream acceptance, application submission, profile
   rewriting, or broad pipeline planning unless that is explicitly part of the schema.
4. Preserve provenance. Any accepted fact, claim, requirement, field mapping, vacancy
   detail, draft answer, or repair must be traceable to the supplied input. Use exact
   quotes, ids, locators, field ids, application ids, job ids, and claim ids when the
   schema provides places for them.
5. Prefer conservative uncertainty over fabrication. Missing evidence, ambiguous page
   state, incomplete forms, unsupported candidate claims, or unverifiable vacancy
   details should become explicit unknowns, ambiguities, findings, or empty arrays
   rather than invented values.
6. Produce only the structured JSON object requested by the schema. Do not wrap it in
   Markdown, do not add commentary outside JSON, and do not include private reasoning.

## Decision rules

- If a field is supported by the supplied input, fill it with the most specific value
  allowed by the schema and cite the supporting input where possible.
- If a field is not supported, leave it empty, mark it unknown, or add a finding based
  on the schema semantics. Never infer skills, dates, locations, authorization,
  compensation, vacancy status, or applicant answers from surrounding context alone.
- If deterministic instructions and model judgment conflict, preserve deterministic
  identifiers, enum values, and gateway constraints. The result gateway will reject
  duplicate identities, unsupported values, and inconsistent verdicts.
- If the task asks for verification, audit the supplied object instead of improving it.
  A verifier may pass clean input, report repairable findings, or mark uncertainty; it
  should not rewrite the underlying artifact.
- If the task asks for repair or refinement, change only the failed or requested parts
  and leave unaffected ids stable. Keep edits grounded in supplied evidence.
- If the call allows live web search, use it only for the discovery objective in the
  task. For all other calls, do not use web search, shell commands, repository files,
  browser automation, MCP tools, or plugin actions.

## Input shape

> One source chunk, its current normalized extraction, and typed blocking coverage findings.

## Output shape

> A typed evidence delta with additions, exact-match removals, and a reasoned resolution for every coverage finding.

## Verification

- JSON Schema validation
- deterministic patch merge
- independent post-repair coverage
