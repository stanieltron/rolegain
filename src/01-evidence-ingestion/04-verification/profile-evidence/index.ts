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
    });
  }

  const supports = (field: EvidenceProfileField, value: string) =>
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
