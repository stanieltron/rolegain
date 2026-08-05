import type { JobSearchWorkspace } from "../../../../contracts/job-search.js";
import type { SourceChunkNotes } from "../../../v1/02-chunk-reader/llm-calls/01-chunk-analysis/output.js";

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
  version?: "v1" | "v2";
}

export function buildInput({
  workspace,
  sourceNotes,
  message,
  version = "v1",
}: EvidenceSynthesisInput): string {
  const action = message
    ? `Re-analyze the supplied candidate evidence with this additional context:\n${message}`
    : "Extract the candidate profile and concrete career evidence from all sources.";
  const allRoleSignals = uniqueObjects(
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
  const roleSignals = selectRoleSignals(allRoleSignals, 40).map((claim) => ({
    action: claim.action,
    capability: claim.capability,
    workContexts: claim.workContexts.slice(0, 4),
    toolsMethods: claim.toolsMethods.slice(0, 10),
    ownership: claim.ownership,
    maturity: claim.maturity,
    scope: claim.scope,
    outcomes: claim.outcomes.slice(0, 3),
  }));
  const chunkFacts = sourceNotes.flatMap((source) =>
    source.chunks.map((chunk) => chunk.profileFacts),
  );
  const profileFacts = {
    names: unique(chunkFacts.map((facts) => facts.name)),
    emails: unique(chunkFacts.map((facts) => facts.email)),
    phones: unique(chunkFacts.map((facts) => facts.phone)),
    linkedin: unique(chunkFacts.map((facts) => facts.linkedin)),
    github: unique(chunkFacts.map((facts) => facts.github)),
    websites: unique(chunkFacts.map((facts) => facts.website)),
    locations: unique(chunkFacts.map((facts) => facts.location)),
    headlines: unique(chunkFacts.map((facts) => facts.headline)).slice(0, 6),
    summaries: unique(chunkFacts.map((facts) => facts.summary)).slice(0, 4),
    skills: unique(chunkFacts.flatMap((facts) => facts.skills)).slice(0, 80),
    languages: unique(chunkFacts.flatMap((facts) => facts.languages)).slice(
      0,
      20,
    ),
  };
  const profileEvidence = uniqueObjects(
    sourceNotes.flatMap((source) =>
      source.chunks.flatMap((chunk) => chunk.profileEvidence),
    ),
    (item) =>
      `${item.field}|${item.value}|${item.sourceId}`.toLowerCase(),
  ).slice(0, 60);
  const materialUnknowns = uniqueObjects(
    sourceNotes.flatMap((source) =>
      source.chunks.flatMap((chunk) => chunk.unknowns),
    ),
    (item) => `${item.field}|${item.reason}`.toLowerCase(),
  ).slice(0, 30);
  const versionRules =
    version === "v2"
      ? `- Return only the consolidated profile, cross-source unknowns/contradictions/prohibited inferences, role families, and the requested semantic search vocabulary. Profile evidence is attached deterministically outside this turn.
- Select profile values only from the supplied extracted profile facts or preserved current profile. Every new scalar field, skill, and language must match a supplied value exactly.
- For each contradiction value, copy sourceId and quote exactly from the supplied profile evidence; do not construct or paraphrase a quote.
- Keep model-owned search vocabulary selective: at most 20 evidence intersections, 60 reusable tools/methods/standards, 20 adjacent dialects, 12 seniority modifiers, 20 geography/language variants, and 20 negative terms. Exclude function names, code identifiers, numeric constants, project names, status words, and one-off implementation details. Title aliases and problem phrases are derived deterministically from role families.`
      : `- Return only the consolidated profile with profileEvidence, cross-source unknowns/contradictions/prohibited inferences, role families, and full search vocabulary.
- Preserve profileEvidence exactly as supplied for every source-derived profile value you select. Every new scalar field, skill, and language needs at least one supporting item. Do not invent or paraphrase quotes.
- Keep search vocabulary selective: at most 30 title aliases, 20 evidence intersections, 30 problem phrases, 60 reusable tools/methods/standards, 20 adjacent dialects, and 12 seniority modifiers. Exclude function names, code identifiers, numeric constants, and one-off implementation details.`;
  return `${action}

Current profile (preserve confirmed non-empty values):
${JSON.stringify(workspace.profile, null, 2)}

Candidate profile facts extracted from source chunks:
${JSON.stringify(profileFacts, null, 2)}

Exact source evidence available for resolving profile values and contradictions:
${JSON.stringify(profileEvidence, null, 2)}

Deduplicated evidence signals for role modelling:
${JSON.stringify(roleSignals, null, 2)}

Material unknowns already observed:
${JSON.stringify(materialUnknowns, null, 2)}

Rules for this turn:
- Do not reproduce source notes, insights, claims, or knowledge Markdown; those are consolidated deterministically outside this turn.
${versionRules}
- Generate direct and adjacent role families; use stretch only when the evidence signals justify it.
- Return 0 to 8 materially distinct role families. Include a direct role family for every strong, separate evidence cluster, but do not meet a numeric target by stretching or duplicating evidence.
- Each role family must name 1 to 8 exact capability strings from the supplied evidence signals in leadingCapabilities. Use only capabilities that materially support that family.
- Base roles on evidence intersections, ownership, maturity, scope, and outcomes rather than title alone.
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

function selectRoleSignals<T extends {
  capability: string;
  ownership: string;
  maturity: string;
  scope: string;
  outcomes: unknown[];
  toolsMethods: string[];
}>(claims: T[], limit: number) {
  const ownership = [
    "unknown",
    "assisted",
    "contributor",
    "primary",
    "shared_owner",
    "lead",
    "manager",
    "end_to_end_owner",
    "organizational_owner",
  ];
  const maturity = [
    "unknown",
    "concept",
    "designed",
    "piloted",
    "implemented",
    "operated",
    "measured",
  ];
  const scope = [
    "unknown",
    "task",
    "process",
    "component",
    "system",
    "service",
    "site",
    "team",
    "department",
    "product",
    "organization",
  ];
  const ranked = [...claims].sort((left, right) => {
    const score = (claim: T) =>
      ownership.indexOf(claim.ownership) * 3 +
      maturity.indexOf(claim.maturity) * 2 +
      scope.indexOf(claim.scope) +
      Math.min(3, claim.outcomes.length) * 2 +
      Math.min(2, claim.toolsMethods.length / 4);
    return score(right) - score(left);
  });
  const selected: T[] = [];
  const capabilities = new Set<string>();
  for (const claim of ranked) {
    const key = claim.capability.toLowerCase().trim();
    if (!key || capabilities.has(key)) continue;
    selected.push(claim);
    capabilities.add(key);
    if (selected.length >= limit) return selected;
  }
  for (const claim of ranked) {
    if (selected.includes(claim)) continue;
    selected.push(claim);
    if (selected.length >= limit) break;
  }
  return selected;
}

function unique(values: Array<string | null | undefined>) {
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export const inputDescription =
  "Current confirmed profile plus deterministically deduplicated facts, evidence signals, and material unknowns from all reader calls.";
