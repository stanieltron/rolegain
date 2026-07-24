# 03 — Independent application verification

[Back to Application Preparation](../README.md) · [Implementation](./index.ts) ·
[Call contract](./llm-calls/01-verification/index.ts)

This stage combines deterministic form checks with a fresh independent
grounding review. It does not rewrite application content.

## Entry point

`verifyApplicationDrafts({ codex, cwd, model, contexts, drafts })`

## Deterministic pre-checks

Before the verifier call, code checks:

- every expected application id appears exactly once;
- a required cover letter is non-empty;
- an unrequested cover letter is empty;
- every answer references a real employer field;
- no field is answered twice;
- every non-empty answer has an evidence basis;
- select/radio values exactly match an employer option.

## LLM boundary

Call id: `application.verify`

The verifier receives original contexts, generated drafts, and deterministic
findings in a fresh process. It checks every material candidate claim against
the supplied evidence and returns `pass` or `needs_repair` with concrete repair
instructions. It cannot browse, use tools, or rewrite the draft.

## Result merge

The stage requires one verdict per context. A missing verdict becomes
`needs_repair`. Deterministic findings always override a model `pass`.

## Output

`ApplicationDraftVerification[]`, each containing application id, verdict,
findings, and repair instructions.

## Branches

- No failures: preparation completes.
- Failures after the first pass: continue to
  [04 — Repair](../04-repair/README.md).
- Failures after the repair pass: reject preparation with an error.
