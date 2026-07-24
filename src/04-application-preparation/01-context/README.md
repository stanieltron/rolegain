# 01 — Application context

[Back to Application Preparation](../README.md) · [Implementation](./index.ts)

This deterministic stage builds the complete evidence packet supplied to every
application-writing call. It is the grounding boundary: later LLM stages may
use this packet and nothing else.

## Entry points

- `buildApplicationContext(workspace, application, dataRoot)` builds one packet.
- `loadRelevantKnowledgeDocuments(...)` performs bounded source selection and
  safe file loading.

## Internal flow

1. Resolve the application and its verified job.
2. Copy confirmed candidate identity, headline, summary, skills, and languages.
3. Add concise insights from active evidence sources.
4. Select detailed knowledge documents cited by requirement matches. If no
   match cites a source, rank active sources against the job and take up to four.
5. Resolve knowledge paths inside `dataRoot`; paths escaping that root are
   rejected.
6. Limit each source to 80,000 characters and the complete packet to 180,000.
7. Add the verified job, every employer field, current values, current cover
   letter, and whether the employer asks for one.

## Output

One serializable application context containing:

- `applicationId`;
- confirmed candidate facts;
- the verified `JobOpportunity` and requirement matrix;
- condensed source insights;
- bounded detailed source documents;
- complete employer-form schema;
- current cover letter and cover-letter requirement.

## Failure behavior

Unknown application or job ids throw. Missing or unsafe knowledge files are
skipped; they are never read from outside the configured data root.

## Consumers

- [02 — Draft](../02-draft/README.md)
- [03 — Verification](../03-verification/README.md)
- [04 — Repair](../04-repair/README.md)
- [05 — Refinement](../05-refinement/README.md)
