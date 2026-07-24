# 05 — User-requested refinement

[Back to Application Preparation](../README.md) · [Implementation](./index.ts)

This stage handles explicit user edits after an application draft exists. It is
not part of automatic draft/verify/repair execution. Both paths rebuild the
same grounded Stage 01 context before calling the model.

## Cover-letter refinement

Entry point: `refineCoverLetter(...)`

Call id: `application.cover-letter-refine`

Inputs include the latest user message, complete current cover letter, visible
cover-letter conversation, verified job, employer fields, and candidate
evidence. Output is the complete revised letter, a concise assistant response,
and the new thread id.

User guidance controls style and emphasis, not facts. Requests for unsupported
claims are ignored.

## Employer-answer refinement

Entry point: `refineApplicationAnswer(...)`

Call id: `application.answer-refine`

Inputs include one target field, current answer/evidence basis, user
instruction, and the complete grounded application context. Output is the
complete revised value plus its evidence basis.

## Tool and evidence boundary

Neither call can browse, use tools, or read arbitrary files. Both operate only
on the context supplied by [01 — Context](../01-context/README.md).

## Persistence

These functions return revisions. `JobSearchService` applies the returned value,
updates the visible conversation or field evidence, recalculates readiness, and
saves the workspace.
