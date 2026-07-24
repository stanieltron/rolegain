import type { JobSearchWorkspace } from "../../../../contracts/job-search.js";
import type { SourceChunkNotes } from "../../../02-chunk-reader/llm-calls/01-chunk-analysis/output.js";

export interface EvidenceSynthesisInput {
  workspace: JobSearchWorkspace;
  sourceNotes: Array<{
    sourceId: string;
    kind: string;
    name: string;
    url?: string;
    chunks: SourceChunkNotes[];
  }>;
  message?: string;
}

export function buildInput({
  workspace,
  sourceNotes,
  message,
}: EvidenceSynthesisInput): string {
  const action = message
    ? `Re-analyze the supplied candidate evidence with this additional context:\n${message}`
    : "Extract the candidate profile and concrete career evidence from all sources.";
  const roleSignals = uniqueObjects(
    sourceNotes.flatMap((source) =>
      source.chunks.flatMap((chunk) =>
        chunk.claims.map((claim) => ({
          action: claim.action,
          capability: claim.capability,
          workContexts: claim.workContexts,
          toolsMethods: claim.toolsMethods,
          credentials: claim.credentials,
          ownership: claim.ownership,
          maturity: claim.maturity,
          scope: claim.scope,
          outcomes: claim.outcomes,
          limitations: claim.limitations,
        })),
      ),
    ),
    (claim) =>
      `${claim.action}|${claim.capability}|${claim.ownership}|${claim.maturity}|${claim.scope}`.toLowerCase(),
  );
  const profileFacts = sourceNotes.flatMap((source) =>
    source.chunks.map((chunk) => ({
      sourceId: source.sourceId,
      ...chunk.profileFacts,
    })),
  );
  const profileEvidence = sourceNotes.flatMap((source) =>
    source.chunks.flatMap((chunk) => chunk.profileEvidence),
  );
  const materialUnknowns = sourceNotes.flatMap((source) =>
    source.chunks.flatMap((chunk) => chunk.unknowns),
  );
  return `${action}

Current profile (preserve confirmed non-empty values):
${JSON.stringify(workspace.profile, null, 2)}

Candidate profile facts extracted from source chunks:
${JSON.stringify(profileFacts, null, 2)}

Exact source evidence available for profile fields:
${JSON.stringify(profileEvidence, null, 2)}

Deduplicated evidence signals for role modelling:
${JSON.stringify(roleSignals, null, 2)}

Material unknowns already observed:
${JSON.stringify(materialUnknowns, null, 2)}

Rules for this turn:
- Do not reproduce source notes, insights, claims, or knowledge Markdown; those are consolidated deterministically outside this turn.
- Return only the consolidated profile with profileEvidence, cross-source unknowns/contradictions/prohibited inferences, role families, and search vocabulary.
- Preserve profileEvidence exactly as supplied for every source-derived profile value you select. Every new scalar field, skill, and language needs at least one supporting item. Do not invent or paraphrase quotes.
- Generate direct and adjacent role families; use stretch only when the evidence signals justify it.
- Return 0 to 8 materially distinct role families. Include a direct role family for every strong, separate evidence cluster, but do not meet a numeric target by stretching or duplicating evidence.
- Each role family must name 1 to 8 exact capability strings from the supplied evidence signals in leadingCapabilities. Use only capabilities that materially support that family.
- Base roles on evidence intersections, ownership, maturity, scope, and outcomes rather than title alone.
- Keep search vocabulary selective: at most 30 title aliases, 20 evidence intersections, 30 problem phrases, 60 reusable tools/methods/standards, 20 adjacent dialects, and 12 seniority modifiers. Exclude function names, code identifiers, numeric constants, and one-off implementation details.
- Preserve profile values that the sources do not contradict. Do not replace preferences with guesses.
- Do not return advice, questions, an audit, a score, or rewritten CV text.`;
}

function uniqueObjects<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export const inputDescription =
  "Current confirmed profile plus deterministically deduplicated facts, evidence signals, and material unknowns from all reader calls.";
