# 04 — Bounded application repair

[Back to Application Preparation](../README.md) · [Implementation](./index.ts) ·
[Call contract](./llm-calls/01-repair/index.ts)

This conditional stage repairs only applications rejected by Stage 03. It runs
at most once per preparation attempt.

## Entry point

`repairApplicationDrafts({ codex, cwd, model, contexts, drafts, failures })`

## Internal flow

1. Build an allow-list from failed application ids.
2. Send only failed contexts, their current drafts, and verifier findings to a
   fresh repair call.
3. Parse complete replacement drafts for failed ids.
4. Merge replacements into the original array; unaffected drafts are retained
   byte-for-byte.

## LLM boundary

Call id: `application.repair`

The repairer cannot acquire new evidence. It must fix only verifier-identified
defects, preserve honest gaps, and avoid rewriting unaffected applications.

## Output

A complete `ApplicationContentDraft[]` in the original order, with accepted
drafts unchanged and returned repairs substituted by application id.

## Failure behavior

Missing repaired ids retain their prior draft and therefore fail the final
verification. There is no second repair attempt.

## Next stage

The failed subset is sent back to
[03 — Verification](../03-verification/README.md) in a fresh context. Any
remaining rejection aborts application preparation.
