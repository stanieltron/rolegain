# 02 — Application draft

[Back to Application Preparation](../README.md) · [Implementation](./index.ts) ·
[Call contract](./llm-calls/01-draft/index.ts)

This stage makes the first application-writing call for a complete batch of
selected applications.

## Entry point

`draftApplicationContent({ codex, cwd, model, contexts })`

## LLM boundary

Call id: `application.draft`

For every supplied application id, the writer:

- writes a tailored cover letter only when the employer requests one;
- returns an empty cover letter otherwise;
- answers empty employer fields only when the supplied evidence supports an
  answer;
- attaches a concise `evidenceBasis` to every non-empty generated answer;
- leaves unconfirmed personal, legal, protected, demographic, compensation, or
  authorization facts empty;
- uses an exact supplied option for select/radio questions.

The call has no tools, browsing, filesystem, or hidden conversation memory.

## Output

An `ApplicationContentDraft[]`, one row per application:

- `applicationId`;
- complete `coverLetter`;
- zero or more `{ fieldId, value, evidenceBasis }` answers.

The JSON schema requires every supplied result to contain an answers array,
even when it is empty.

## Failure behavior

An empty input returns immediately. Runtime, authentication, schema, or parse
errors abort preparation; drafts are not applied to the workspace.

## Next stage

Every draft goes to [03 — Verification](../03-verification/README.md).
