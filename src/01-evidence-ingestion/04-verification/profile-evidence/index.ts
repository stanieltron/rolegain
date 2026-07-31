import { createHash } from "node:crypto";
import type {
  CandidateProfile,
  CandidateSource,
} from "../../../contracts/job-search.js";
import type {
  EvidenceReadiness,
  EvidenceProfileField,
  ProfileFieldEvidence,
  ProfileFieldEvidenceDraft,
} from "../../../contracts/evidence.js";

const SCALAR_FIELDS: EvidenceProfileField[] = [
  "name",
  "email",
  "phone",
  "linkedin",
  "github",
  "website",
  "location",
  "headline",
  "summary",
];
const ARRAY_FIELDS: EvidenceProfileField[] = ["skills", "languages"];

export interface ProfileEvidenceAudit {
  verified: ProfileFieldEvidence[];
  blockers: string[];
  supports: (field: EvidenceProfileField, value: string) => boolean;
}

/** Verify that every newly selected profile value points to an exact source quote. */
export function auditProfileEvidence(input: {
  baseline: CandidateProfile;
  proposed: CandidateProfile;
  sources: CandidateSource[];
  evidence: ProfileFieldEvidenceDraft[];
}): ProfileEvidenceAudit {
  const sources = new Map(input.sources.map((source) => [source.id, source]));
  const verified: ProfileFieldEvidence[] = [];
  const seen = new Set<string>();

  for (const draft of input.evidence || []) {
    const source = sources.get(draft.sourceId);
    const value = draft.value.trim();
    const quote = draft.quote.trim();
    if (
      !source ||
      !value ||
      !quote ||
      !selected(input.proposed, draft.field, value)
    )
      continue;
    const locator = locateQuote(source.content || "", quote);
    if (!locator) continue;
    const key = `${draft.field}|${value.toLowerCase()}|${source.id}|${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    verified.push({
      field: draft.field,
      value,
      sourceId: source.id,
      sourceVersionId:
        source.kind === "cv"
          ? source.id
          : `source-${hash(source.contentHash || source.content || "").slice(0, 20)}`,
      locator,
      quote,
      quoteHash: hash(quote),
      matchStrength: "explicit",
      confidence: 1,
    });
  }

  let supports = (field: EvidenceProfileField, value: string) =>
    verified.some(
      (item) =>
        item.field === field &&
        item.value.toLowerCase() === value.trim().toLowerCase(),
    );
  for (const value of array(input.proposed.skills)) {
    if (supports("skills", value)) continue;
    const recovered = recoverSkillEvidence(value, input.sources);
    if (!recovered) continue;
    verified.push({
      field: "skills",
      value,
      sourceId: recovered.source.id,
      sourceVersionId:
        recovered.source.kind === "cv"
          ? recovered.source.id
          : `source-${hash(
              recovered.source.contentHash ||
                recovered.source.content ||
                "",
            ).slice(0, 20)}`,
      locator: lineLocator(
        recovered.source.content || "",
        recovered.start,
        recovered.end,
      ),
      quote: recovered.quote,
      quoteHash: hash(recovered.quote),
      matchStrength: recovered.matchStrength,
      confidence: recovered.confidence,
    });
  }
  supports = (field: EvidenceProfileField, value: string) =>
    verified.some(
      (item) =>
        item.field === field &&
        item.value.toLowerCase() === value.trim().toLowerCase(),
    );
  const blockers: string[] = [];
  for (const field of SCALAR_FIELDS) {
    const baseline = scalar(input.baseline[field]);
    const proposed = scalar(input.proposed[field]);
    const derivedNarrative = field === "headline" || field === "summary";
    if (
      proposed &&
      !derivedNarrative &&
      proposed !== baseline &&
      !supports(field, proposed)
    )
      blockers.push(
        `Profile field ${field}=${JSON.stringify(proposed)} has no exact source provenance`,
      );
  }
  for (const field of ARRAY_FIELDS) {
    const baseline = new Set(
      array(input.baseline[field]).map((item) => item.toLowerCase()),
    );
    for (const value of array(input.proposed[field]))
      if (
        (field === "skills" || !baseline.has(value.toLowerCase())) &&
        !supports(field, value)
      )
        blockers.push(
          `Profile field ${field} contains ${JSON.stringify(value)} without exact source provenance`,
        );
  }
  return { verified, blockers, supports };
}

/**
 * Headline and summary are optional synthesis output, not atomic candidate
 * facts. Older runs incorrectly treated an unsupported synthesis as a fatal
 * readiness blocker even though applyCandidateAnalysis had already discarded
 * the value. Remove only that obsolete blocker; factual profile fields remain
 * subject to exact-source verification.
 */
export function repairDerivedNarrativeReadiness(
  readiness: EvidenceReadiness,
): EvidenceReadiness {
  const blockers = readiness.blockers.filter(
    (blocker) =>
      !/^Profile field (?:headline|summary)=.* has no exact source provenance$/s.test(
        blocker,
      ),
  );
  if (blockers.length === readiness.blockers.length) return readiness;
  return {
    ...readiness,
    readyForSearch: blockers.length === 0,
    blockers,
  };
}

function selected(
  profile: CandidateProfile,
  field: EvidenceProfileField,
  value: string,
) {
  const current = profile[field];
  return Array.isArray(current)
    ? current.some((item) => item.toLowerCase() === value.toLowerCase())
    : current.trim().toLowerCase() === value.toLowerCase();
}

function scalar(value: string | string[]) {
  return typeof value === "string" ? value.trim() : "";
}

function array(value: string | string[]) {
  return Array.isArray(value)
    ? value.map((item) => item.trim()).filter(Boolean)
    : [];
}

function locateQuote(content: string, quote: string) {
  const direct = content.indexOf(quote);
  if (direct >= 0) return lineLocator(content, direct, direct + quote.length);
  const normalizedQuote = normalizeLayoutText(quote);
  const lines = content.split("\n");
  for (let start = 0; start < lines.length; start += 1) {
    let text = "";
    for (let end = start; end < Math.min(lines.length, start + 12); end += 1) {
      text = normalizeLayoutText(`${text} ${lines[end]}`);
      if (text.includes(normalizedQuote)) return `lines ${start + 1}-${end + 1}`;
    }
  }
  return "";
}

function normalizeLayoutText(value: string) {
  return value.replace(/-\s+/g, "-").replace(/\s+/g, " ").trim();
}

function lineLocator(content: string, start: number, end: number) {
  return `lines ${content.slice(0, start).split("\n").length}-${content.slice(0, end).split("\n").length}`;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

interface SourceToken {
  value: string;
  start: number;
  end: number;
}

const GENERIC_SKILL_MODIFIERS = new Set([
  "analysis",
  "architecture",
  "development",
  "design",
  "engineering",
  "execution",
  "implementation",
  "infrastructure",
  "integration",
  "management",
  "operations",
  "orchestration",
  "platform",
  "systems",
]);

function recoverSkillEvidence(
  skill: string,
  sources: CandidateSource[],
):
  | {
      source: CandidateSource;
      quote: string;
      start: number;
      end: number;
      matchStrength: "recovered_exact" | "recovered_context";
      confidence: number;
    }
  | undefined {
  const selected = skill.trim();
  if (!selected) return undefined;

  // Prefer a literal phrase wherever it exists, independent of capitalization.
  for (const source of sources) {
    const content = source.content || "";
    const span = literalSkillSpan(content, selected);
    if (!span) continue;
    return recoveredSourcePassage(
      source,
      span.start,
      span.end,
      "recovered_exact",
      0.98,
    );
  }

  const skillTokens = tokenize(selected);
  if (!skillTokens.length) return undefined;

  // Accept wording such as "vector and hybrid search" for "Vector search".
  for (const source of sources) {
    const sourceTokens = tokenize(source.content || "");
    const span = orderedTokenSpan(
      skillTokens.map((token) => token.value),
      sourceTokens,
      Math.max(8, skillTokens.length + 6),
    );
    if (!span) continue;
    return recoveredSourcePassage(
      source,
      span.start,
      span.end,
      "recovered_context",
      0.86,
    );
  }

  // Technical prose often reverses or interrupts the synthesized label:
  // "replayed historical ETH data" still supports "Historical data replay".
  for (const source of sources) {
    const sourceTokens = tokenize(source.content || "");
    const span = unorderedTokenSpan(
      skillTokens.map((token) => token.value),
      sourceTokens,
      Math.max(24, skillTokens.length + 18),
    );
    if (!span) continue;
    return recoveredSourcePassage(
      source,
      span.start,
      span.end,
      "recovered_context",
      0.8,
    );
  }

  // A source may state the distinctive technology or domain but omit a generic
  // modifier selected by synthesis, e.g. "Kubernetes" -> "Kubernetes
  // operations". Keep this skill with visibly weaker provenance.
  const distinctiveTokens = skillTokens
    .map((token) => token.value)
    .filter(
      (token) =>
        token.length >= 3 && !GENERIC_SKILL_MODIFIERS.has(token),
    );
  if (!distinctiveTokens.length || distinctiveTokens.length === skillTokens.length)
    return undefined;
  for (const source of sources) {
    const sourceTokens = tokenize(source.content || "");
    const span = orderedTokenSpan(
      distinctiveTokens,
      sourceTokens,
      Math.max(10, distinctiveTokens.length + 8),
    );
    if (!span) continue;
    return recoveredSourcePassage(
      source,
      span.start,
      span.end,
      "recovered_context",
      0.72,
    );
  }
  return undefined;
}

function tokenize(value: string): SourceToken[] {
  const tokens: SourceToken[] = [];
  for (const match of value.matchAll(/[\p{L}\p{N}+#]+/gu)) {
    if (match.index === undefined) continue;
    tokens.push({
      value: canonicalSkillToken(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

function canonicalSkillToken(value: string) {
  const token = value.toLocaleLowerCase();
  const aliases: Record<string, string> = {
    postgres: "postgres",
    postgresql: "postgres",
    websocket: "websocket",
    websockets: "websocket",
    ws: "websocket",
    indexed: "index",
    indexer: "index",
    indexers: "index",
    indexes: "index",
    indexing: "index",
    replayed: "replay",
    replays: "replay",
    mechanisms: "mechanism",
    designed: "design",
    designing: "design",
  };
  return aliases[token] || token;
}

function literalSkillSpan(content: string, selected: string) {
  const haystack = content.toLocaleLowerCase();
  const needle = selected.toLocaleLowerCase();
  let from = 0;
  while (from < haystack.length) {
    const start = haystack.indexOf(needle, from);
    if (start < 0) return undefined;
    const end = start + selected.length;
    const before = start > 0 ? content[start - 1] : "";
    const after = end < content.length ? content[end] : "";
    if (!isSkillWordCharacter(before) && !isSkillWordCharacter(after))
      return { start, end };
    from = start + 1;
  }
  return undefined;
}

function isSkillWordCharacter(value: string) {
  return Boolean(value && /[\p{L}\p{N}+#]/u.test(value));
}

function orderedTokenSpan(
  expected: string[],
  source: SourceToken[],
  maximumSpan: number,
) {
  for (let startIndex = 0; startIndex < source.length; startIndex += 1) {
    if (source[startIndex].value !== expected[0]) continue;
    let expectedIndex = 1;
    let endIndex = startIndex;
    while (
      expectedIndex < expected.length &&
      endIndex + 1 < source.length &&
      endIndex - startIndex + 1 < maximumSpan
    ) {
      endIndex += 1;
      if (source[endIndex].value === expected[expectedIndex])
        expectedIndex += 1;
    }
    if (expectedIndex === expected.length)
      return {
        start: source[startIndex].start,
        end: source[endIndex].end,
      };
  }
  return undefined;
}

function unorderedTokenSpan(
  expected: string[],
  source: SourceToken[],
  maximumSpan: number,
) {
  const required = new Set(expected);
  for (let startIndex = 0; startIndex < source.length; startIndex += 1) {
    if (!required.has(source[startIndex].value)) continue;
    const found = new Set<string>();
    for (
      let endIndex = startIndex;
      endIndex < source.length && endIndex - startIndex < maximumSpan;
      endIndex += 1
    ) {
      if (required.has(source[endIndex].value))
        found.add(source[endIndex].value);
      if (found.size === required.size)
        return {
          start: source[startIndex].start,
          end: source[endIndex].end,
        };
    }
  }
  return undefined;
}

function recoveredSourcePassage(
  source: CandidateSource,
  evidenceStart: number,
  evidenceEnd: number,
  matchStrength: "recovered_exact" | "recovered_context",
  confidence: number,
) {
  const content = source.content || "";
  let start = content.lastIndexOf("\n", evidenceStart) + 1;
  let end = content.indexOf("\n", evidenceEnd);
  if (end < 0) end = content.length;
  if (end - start > 500) {
    start = Math.max(0, evidenceStart - 140);
    end = Math.min(content.length, evidenceEnd + 220);
  }
  while (start < evidenceStart && /\s/.test(content[start])) start += 1;
  while (end > evidenceEnd && /\s/.test(content[end - 1])) end -= 1;
  return {
    source,
    quote: content.slice(start, end),
    start,
    end,
    matchStrength,
    confidence,
  };
}
