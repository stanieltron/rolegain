import type { SourceChunkNotes } from "../llm-calls/01-chunk-analysis/output.js";
import type { ChunkRepairPatch } from "../llm-calls/03-chunk-repair/output.js";
import type { ChunkReadJob } from "../recovery/run-reader-with-coverage.js";

type Normalizer = (
  value: Partial<SourceChunkNotes>,
  sourceId: string,
  locator: string,
) => SourceChunkNotes;

/** Apply a model-produced delta without allowing it to replace unrelated evidence. */
export function applyChunkRepairPatch(input: {
  current: SourceChunkNotes;
  patch: ChunkRepairPatch;
  job: ChunkReadJob;
  normalize: Normalizer;
}): SourceChunkNotes {
  const { current, patch, job } = input;
  const additions = input.normalize(
    patch.additions,
    job.source.id,
    job.locator,
  );
  const removals = patch.removals || [];
  const removedProfileFields = new Set(
    removals
      .filter((item) => item.target === "profileFact")
      .map((item) => item.match),
  );

  const profileEvidence = unique(
    [
      ...current.profileEvidence.filter(
        (item) =>
          !removals.some(
            (removal) =>
              removal.target === "profileEvidence" &&
              (removal.match === item.value || removal.match === item.quote),
          ),
      ),
      ...additions.profileEvidence.filter((item) => containsQuote(job.chunk, item.quote)),
    ],
    (item) => `${item.field}|${item.value}|${item.quote}`,
  );

  const profileFacts = { ...current.profileFacts };
  const profileFields = new Set<keyof typeof profileFacts>([
    ...(Object.keys(profileFacts) as Array<keyof typeof profileFacts>),
    ...(Object.keys(additions.profileFacts) as Array<keyof typeof profileFacts>),
  ]);
  for (const field of profileFields) {
    if (removedProfileFields.has(field))
      profileFacts[field] = (Array.isArray(profileFacts[field]) ? [] : "") as never;
    const added = additions.profileFacts[field];
    if (Array.isArray(added)) {
      const supported = added.filter((value) =>
        profileEvidence.some(
          (evidence) => evidence.field === field && evidence.value === value,
        ),
      );
      profileFacts[field] = unique(
        [...(Array.isArray(profileFacts[field]) ? profileFacts[field] as string[] : []), ...supported],
        (value) => value.toLowerCase(),
      ) as never;
    } else if (
      added.trim() &&
      profileEvidence.some(
        (evidence) => evidence.field === field && evidence.value === added,
      )
    ) {
      profileFacts[field] = added as never;
    }
  }

  const claims = unique(
    [
      ...current.claims.filter(
        (claim) =>
          !removals.some(
            (removal) =>
              removal.target === "claim" &&
              claim.sourceEvidence.some((evidence) => evidence.quote === removal.match),
          ),
      ),
      ...additions.claims.filter(
        (claim) =>
          claim.sourceEvidence.length > 0 &&
          claim.sourceEvidence.every((evidence) => containsQuote(job.chunk, evidence.quote)),
      ),
    ],
    (claim) =>
      `${claim.action}|${claim.capability}|${claim.sourceEvidence.map((item) => item.quote).join("|")}`.toLowerCase(),
  );

  return {
    profileFacts,
    profileEvidence,
    insights: unique(
      [
        ...current.insights.filter(
          (item) =>
            !removals.some(
              (removal) => removal.target === "insight" && removal.match === item.id,
            ),
        ),
        ...additions.insights.filter((item) => containsQuote(job.chunk, item.evidence)),
      ],
      (item) => `${item.title}|${item.summary}`.toLowerCase(),
    ),
    detailedNotes: [current.detailedNotes.trim(), additions.detailedNotes.trim()]
      .filter(Boolean)
      .join("\n\n## Coverage repair\n\n"),
    claims,
    unknowns: unique(
      [
        ...current.unknowns.filter(
          (item) =>
            !removals.some(
              (removal) => removal.target === "unknown" && removal.match === item.field,
            ),
        ),
        ...additions.unknowns,
      ],
      (item) => `${item.field}|${item.reason}`.toLowerCase(),
    ),
    prohibitedInferences: unique(
      [
        ...current.prohibitedInferences.filter(
          (item) =>
            !removals.some(
              (removal) =>
                removal.target === "prohibitedInference" && removal.match === item.rule,
            ),
        ),
        ...additions.prohibitedInferences,
      ],
      (item) => `${item.rule}|${item.reason}`.toLowerCase(),
    ),
  };
}

function containsQuote(content: string, quote: string) {
  const normalizedContent = content.replace(/-\s+/g, "-").replace(/\s+/g, " ").trim();
  const normalizedQuote = quote.replace(/-\s+/g, "-").replace(/\s+/g, " ").trim();
  return Boolean(normalizedQuote) && normalizedContent.includes(normalizedQuote);
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
