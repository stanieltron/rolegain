export function buildInput(input: {
  unresolved: unknown;
  documents: unknown;
}) {
  return `Reassess every unresolved requirement below using only the selected Tier 2 notes.

Unresolved Tier 1 rows:
${JSON.stringify(input.unresolved, null, 2)}

Selected Tier 2 notes:
${JSON.stringify(input.documents, null, 2)}

Rules:
- Return the supplied jobId once at the top level and one requirements array containing exactly one row for every supplied unresolved requirement. Preserve each requirement and kind verbatim so it can be merged safely.
- matched requires direct detailed evidence; partial requires genuinely adjacent or narrower detailed evidence; missing must have no evidence.
- Every matched or partial row must preserve the supplied claimId and sourceId and copy its exact excerpt. A weakly_supported claim may justify partial only.
- A complex-system requirement may be supported by concrete multi-component architecture, difficult algorithms, failure handling, integration constraints, or other demonstrated implementation complexity.
- Do not treat a large repository, many technologies, or architectural complexity by itself as proof that a system is scalable, high-volume, or production-scale.
- A scalable or high-volume requirement needs explicit scale evidence such as operated load or throughput, horizontal scaling, partitioning, queues, caching, concurrency control, backpressure, load testing, or performance work. An explicit scale-oriented design without evidence that it operated at scale is normally partial, not matched.
- Every matched or partial row must cite the sourceId of the supporting Tier 2 note and a short faithful excerpt or close paraphrase. Use no source outside the supplied notes.
- Explain what the details establish and state any remaining limitation. Do not calculate fit percentages.`;
}

export const inputDescription =
  "Only unresolved Tier 1 requirement rows and selected detailed evidence notes with canonical citations.";
