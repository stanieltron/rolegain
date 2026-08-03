import { createHash } from "node:crypto";
import type {
  ApplicationDraft,
  JobOpportunity,
  JobResearchFailure,
  JobSearchWorkspace,
} from "../contracts/job-search.js";
import { normalizeExtractedText, repairMojibake } from "../infrastructure/text-encoding.js";
import { selectedWorkModes, willingWorkLocations } from "./work-preferences.js";
import { classifySearchValidationFailure } from "../02-search/v1/03-vacancy-validation/failure-classification.js";
import type { DiscoveredJob, LiveCandidate } from "./types.js";

export function normalizeOpportunityUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, "").toLowerCase();
  }
}

export function canonicalVacancyIdentity(candidate: LiveCandidate) {
  const normalizeIdentity = (value: string) =>
    repairMojibake(value)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return [
    normalizeIdentity(candidate.company),
    normalizeIdentity(candidate.job.title),
    normalizeIdentity(candidate.job.location || candidate.job.workplaceType || ""),
  ].join("::");
}

export function authoritativeSourceConfidence(jobUrl: string, applyUrl: string) {
  try {
    const job = new URL(jobUrl);
    const apply = new URL(applyUrl);
    const employerAts = /(?:ashbyhq\.com|greenhouse\.io|lever\.co|myworkdayjobs\.com|smartrecruiters\.com)$/i;
    if (employerAts.test(job.hostname) || employerAts.test(apply.hostname)) return 0.95;
    if (job.hostname === apply.hostname) return 0.9;
    return 0.75;
  } catch {
    return 0;
  }
}

export function validationRiskSignals(job: DiscoveredJob) {
  const signals: string[] = [];
  if (!job.publishedAt) signals.push("posting_date_unavailable");
  if (
    normalizeOpportunityUrl(job.applyUrl) === normalizeOpportunityUrl(job.jobUrl) &&
    !/\/application|\/apply\b/i.test(job.applyUrl)
  )
    signals.push("application_path_not_distinct");
  if ((job.descriptionPlain || "").trim().length < 500)
    signals.push("description_may_be_incomplete");
  return signals;
}

function roundScore(value: number) {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

export function calculateOpportunityConfidence(input: {
  sourceConfidence: number;
  hasApplicationPath: boolean;
  descriptionComplete: boolean;
  statusConsistent: boolean;
  hasPublishedDate: boolean;
  riskSignalCount: number;
}) {
  return roundScore(
    input.sourceConfidence * 0.35 +
      (input.hasApplicationPath ? 0.25 : 0) +
      (input.descriptionComplete ? 0.2 : 0) +
      (input.statusConsistent ? 0.15 : 0) +
      (input.hasPublishedDate ? 0.05 : 0) -
      Math.min(0.2, input.riskSignalCount * 0.05),
  );
}

export function candidateFromOpportunity(opportunity: JobOpportunity): LiveCandidate {
  return {
    company: opportunity.company,
    preliminaryFit: opportunity.fit,
    job: {
      id: opportunity.id.replace(/^live-/, ""),
      title: opportunity.title,
      location: opportunity.location,
      workplaceType: opportunity.workplace,
      isRemote: /remote/i.test(opportunity.workplace),
      jobUrl: opportunity.sourceUrl,
      applyUrl: opportunity.applyUrl,
      descriptionPlain: opportunity.description || opportunity.summary,
      compensation: opportunity.compensation,
      sourceKind: "vacancy",
      discoveryQuery: opportunity.discoveryProvenance?.[0]?.query,
      discoveryWave: opportunity.discoveryProvenance?.[0]?.wave,
      sourceClass: opportunity.discoveryProvenance?.[0]?.sourceClass,
    },
  };
}

export function researchFailure(
  candidate: LiveCandidate,
  stage: JobResearchFailure["stage"],
  reason: string,
): JobResearchFailure {
  const classification = classifySearchValidationFailure(reason, stage);
  return {
    id: createHash("sha256")
      .update(`${candidate.job.jobUrl}:${stage}:${reason}`)
      .digest("hex")
      .slice(0, 20),
    company: candidate.company || "Unknown employer",
    title: candidate.job.title || "Unknown position",
    location: candidate.job.location || "Not specified",
    sourceUrl: candidate.job.jobUrl,
    applyUrl: candidate.job.applyUrl,
    stage,
    ...classification,
    reason,
    capturedAt: new Date().toISOString(),
  };
}

export function failureFromOpportunity(
  opportunity: JobOpportunity,
  stage: JobResearchFailure["stage"],
  reason: string,
): JobResearchFailure {
  return {
    ...researchFailure(candidateFromOpportunity(opportunity), stage, reason),
    jobNumber: opportunity.jobNumber,
  };
}

export function deduplicateFailures(failures: JobResearchFailure[]) {
  const byKey = new Map<string, JobResearchFailure>();
  for (const failure of failures)
    byKey.set(
      `${normalizeOpportunityUrl(failure.sourceUrl)}:${failure.stage}`,
      failure,
    );
  return [...byKey.values()];
}

export function isPublicWebUrl(value: string) {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}


export function adapterForUrl(url: string): ApplicationDraft["adapter"] {
  const value = url.toLowerCase();
  if (value.includes("greenhouse")) return "greenhouse";
  if (value.includes("lever.co")) return "lever";
  if (value.includes("ashbyhq")) return "ashby";
  if (value.includes("openai.com/careers")) return "openai-careers";
  return "generic";
}

export function matchesWorkplace(
  job: DiscoveredJob,
  workspace: JobSearchWorkspace,
) {
  const modes = selectedWorkModes(workspace.profile.workplace);
  if (modes.length === 0) return true;
  const remote = hasAffirmativeRemoteSignal(job);
  if (modes.includes("Remote") && remote) return true;
  const workplace = `${job.workplaceType || ""}`.toLowerCase();
  const location = [
    job.location,
    job.workplaceType,
    ...(job.secondaryLocations || []).map((item) => item.location),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const detectedMode = /\bhybrid\b/.test(workplace)
    ? "Hybrid"
    : remote
      ? "Remote"
      : /on[- ]?site|in[- ]office|office[- ]based/.test(workplace)
        ? "On-site"
        : "Unknown";
  if (detectedMode === "Remote") return false;
  const targetLocations = willingWorkLocations(workspace.profile.targetLocations);
  if (!matchesWillingWorkLocation(location, targetLocations)) return false;
  if (modes.includes("Hybrid") && detectedMode === "Hybrid") return true;
  if (
    modes.includes("On-site") &&
    (detectedMode === "On-site" || detectedMode === "Unknown")
  )
    return true;
  return false;
}

export function hasAffirmativeRemoteSignal(job: DiscoveredJob) {
  if (job.isRemote) return true;
  const text = [
    job.location,
    job.workplaceType,
    ...(job.secondaryLocations || []).map((item) => item.location),
    job.descriptionPlain,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const withoutNegatedRemote = text
    .replace(
      /\b(?:not|no)\s+(?:an?\s+)?remote(?:ly)?(?:\s+(?:role|position|job|option|work|working))?\b/g,
      " ",
    )
    .replace(/\bnon[-\s]?remote\b/g, " ")
    .replace(
      /\bremote\s+(?:work|working|option)\s+(?:is\s+)?(?:not\s+available|unavailable|not\s+offered)\b/g,
      " ",
    );
  return (
    /\bremote(?:ly)?\b/.test(withoutNegatedRemote) ||
    /\bwork(?:ing)?\s+from\s+(?:home|anywhere)\b/.test(withoutNegatedRemote)
  );
}

export const broadRemoteRegionPattern =
  /european union|\beurope\b|\bemea\b|\beu\b|anywhere|worldwide|\bglobal(?:ly)?\b/i;

/**
 * Returns a short, explicit remote-eligibility clause from the vacancy text.
 * A generic reference to a remote or global team is deliberately insufficient:
 * the broad geography must directly qualify "remote" or "work from anywhere".
 */
export function explicitBroadRemoteEligibilityClause(description: string) {
  const text = description.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const clauses = text.split(/(?<=[.!?])\s+/);
  for (const clause of clauses) {
    if (!broadRemoteRegionPattern.test(clause)) continue;
    if (
      /\bremote\b\s*(?:[-—:,(]|\b(?:in|from|within|throughout|across|anywhere|for|to)\b)[^.!?]{0,180}(?:european union|\beurope\b|\bemea\b|\beu\b|anywhere|worldwide|\bglobal(?:ly)?\b)/i.test(
        clause,
      ) ||
      /\bwork\s+from\s+(?:anywhere|(?:the\s+)?(?:european union|europe|emea|eu))\b/i.test(
        clause,
      )
    )
      return clause.slice(0, 240).trim();
  }
  return "";
}

export function reconcileRemoteLocation(
  job: Pick<
    DiscoveredJob,
    "location" | "workplaceType" | "isRemote" | "descriptionPlain"
  >,
) {
  const location = (job.location || "").trim();
  const isRemote =
    job.isRemote || /remote|anywhere|worldwide|global/i.test(job.workplaceType || "");
  if (!isRemote || broadRemoteRegionPattern.test(location)) return location;
  return explicitBroadRemoteEligibilityClause(job.descriptionPlain || "") || location;
}

export function matchesWillingWorkLocation(
  jobLocation: string,
  targetLocations: string[],
) {
  if (targetLocations.length === 0) return false;
  const normalizedJobLocation = normalizeLocationForMatch(jobLocation);
  return targetLocations.some((target) => {
    const normalizedTarget = normalizeLocationForMatch(target);
    if (!normalizedTarget) return false;
    if (
      normalizedJobLocation.includes(normalizedTarget) ||
      normalizedTarget.includes(normalizedJobLocation)
    )
      return true;
    const [primaryTarget] = target.split(",");
    const normalizedPrimary = normalizeLocationForMatch(primaryTarget);
    return normalizedPrimary.length >= 3
      ? normalizedJobLocation.includes(normalizedPrimary)
      : false;
  });
}

export function normalizeLocationForMatch(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}


export function meetsCompensationFloor(
  compensation: string,
  workspace: JobSearchWorkspace,
  eurPerUnit: Record<string, number>,
) {
  const floor = workspace.profile.salaryExpectation.match(
    /^(EUR|USD|GBP|CHF|CZK|PLN|CAD|AUD)\s+(\d+)/i,
  );
  if (!floor) return true;
  const parsed = compensation
    .split(/\s+\|\s+/)
    .flatMap((part) => parseCompensationRanges(part));
  // Undisclosed compensation is unresolved, not a proven hard-constraint
  // violation. It is retained and classified by the feasibility gate.
  if (parsed.length === 0) return true;
  const normalizedFloor = toEur(
    Number(floor[2]),
    floor[1].toUpperCase(),
    false,
    eurPerUnit,
  );
  return parsed.every(
    (range) =>
      toEur(range.minimum, range.currency, range.hourly, eurPerUnit) >=
      normalizedFloor,
  );
}

export function parseCompensationRanges(value: string) {
  const normalized = value
    .replace(/,/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[–—]/g, "-");
  const token = "EUR|USD|GBP|CHF|CZK|PLN|CAD|AUD|€|\\$|£";
  const results: Array<{
    index: number;
    minimum: number;
    currency: string;
    hourly: boolean;
  }> = [];
  const hourly = /(?:\/|per\s+)h(?:ou)?r/i.test(normalized);
  const patterns = [
    {
      expression: new RegExp(
        `(${token})\\s*([\\d.]+)\\s*([kK])?(?:\\s*(?:-|to)\\s*(?:${token})?\\s*[\\d.]+\\s*[kK]?)?`,
        "gi",
      ),
      value: 2,
      thousands: 3,
      currency: 1,
    },
    {
      expression: new RegExp(
        `([\\d.]+)\\s*([kK])?(?:\\s*(?:-|to)\\s*[\\d.]+\\s*[kK]?)?\\s*(${token})`,
        "gi",
      ),
      value: 1,
      thousands: 2,
      currency: 3,
    },
  ];
  for (const pattern of patterns)
    for (const match of normalized.matchAll(pattern.expression))
      results.push({
        index: match.index ?? 0,
        minimum:
          Number(match[pattern.value]) *
          (match[pattern.thousands] ? 1000 : 1),
        currency: normalizeCurrency(match[pattern.currency]),
        hourly,
      });
  const unique = new Map<string, (typeof results)[number]>();
  for (const result of results)
    if (Number.isFinite(result.minimum) && result.minimum > 0)
      unique.set(`${result.index}:${result.currency}`, result);
  return [...unique.values()]
    .sort((a, b) => a.index - b.index)
    .map(({ index: _index, ...result }) => result);
}

export function normalizeCurrency(value: string) {
  if (value === "€") return "EUR";
  if (value === "$") return "USD";
  if (value === "£") return "GBP";
  return value.toUpperCase();
}

export function toEur(
  amount: number,
  currency: string,
  hourly: boolean,
  eurPerUnit: Record<string, number>,
) {
  const annual = hourly ? amount * 2_080 : amount;
  return annual * (eurPerUnit[currency] || 0);
}

export async function currentEurExchangeRates() {
  const response = await fetch(
    "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
    {
      headers: { "User-Agent": "Job-Apply-Go/0.1" },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error("Could not validate the compensation floor against current ECB exchange rates");
  const xml = await response.text();
  const rates: Record<string, number> = { EUR: 1 };
  for (const match of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g))
    rates[match[1]] = 1 / Number(match[2]);
  if (!rates.USD || !rates.GBP || !rates.PLN)
    throw new Error("ECB exchange-rate response was incomplete");
  return rates;
}

export function normalizeCompensationText(value: string) {
  const text = normalizeExtractedText(value).replace(/\s+/g, " ").trim();
  if (!text || /^not disclosed$/i.test(text)) return "";
  if (parseCompensationRanges(text).length === 0) return "";
  const hasPayLabel =
    /salary|compensation|base pay|pay range|annual gross|gross pay|wage|r[eé]mun[eé]ration|salaire|brut(?:e)?\b|mensuel|annuel/i.test(
      text,
    );
  const hasRate =
    /(?:\/|per\s+)(?:h(?:ou)?r|day|week|month|year)|par\s+(?:heure|jour|semaine|mois|an)|horaire|mensuel|annuel/i.test(
      text,
    );
  const hasRange =
    /(?:EUR|USD|GBP|CHF|CZK|PLN|CAD|AUD|€|\$|£)\s*[\d.]+\s*[kK]?\s*(?:-|–|—|to|à)\s*(?:(?:EUR|USD|GBP|CHF|CZK|PLN|CAD|AUD|€|\$|£)\s*)?[\d.]+/i.test(
      text,
    ) ||
    /[\d.]+\s*[kK]?\s*(?:-|–|—|to|à)\s*[\d.]+\s*[kK]?\s*(?:EUR|USD|GBP|CHF|CZK|PLN|CAD|AUD|€|\$|£)/i.test(
      text,
    );
  const isolatedAmount =
    text.length <= 80 &&
    /^(?:(?:EUR|USD|GBP|CHF|CZK|PLN|CAD|AUD|€|\$|£)\s*[\d.]+\s*[kK]?|[\d.]+\s*[kK]?\s*(?:EUR|USD|GBP|CHF|CZK|PLN|CAD|AUD|€|\$|£))(?:\s+(?:gross|net|brut(?:e)?))?$/i.test(
      text,
    );
  const benefitOnly =
    /reimburse|rembours|mutuelle|benefit|avantage|wellness|bien[- ]être|allowance|budget|prime de naissance|courtier/i.test(
      text,
    ) && !hasPayLabel;
  return !benefitOnly && (hasPayLabel || hasRate || hasRange || isolatedAmount)
    ? text
    : "";
}

export function extractCompensation(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .map(normalizeCompensationText)
    .filter(Boolean)
    .slice(0, 4)
    .join(" | ")
    .slice(0, 900);
}


export function summarize(text: string) {
  const cleaned = normalizeExtractedText(text).replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 360) || "Live vacancy validated from the public web.";
}

export function extractRequirements(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^[-•*]\s*/, "").trim())
    .filter((line) => line.length >= 25 && line.length <= 220)
    .filter((line) => /experience|ability|proficien|knowledge|strong|expert|years/i.test(line))
    .slice(0, 8);
}

/**
 * Extract the employer-authored candidate qualification block from vacancy text.
 * Job boards often flatten headings and paragraphs into one line, so this cannot
 * rely on newlines or DOM structure.
 */
export function extractQualificationSection(text: string) {
  const normalized = normalizeExtractedText(text).replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  const requiredHeadings = [
    /\bminimum requirements\b/i,
    /\bbasic qualifications\b/i,
    /\brequired qualifications\b/i,
    /\bmust[- ]haves?\b/i,
    /\bwhat (?:you|you['’]ll) bring\b/i,
    /\bwhat we['’]re looking for\b/i,
    /\bwho you are\b/i,
    /\bcandidate requirements\b/i,
    /\brequirements\s*:/i,
    /\bqualifications\s*:/i,
  ];
  const preferredHeadings = [
    /\bpreferred qualifications\b/i,
    /\bnice to have\b/i,
    /\bbonus qualifications\b/i,
  ];
  const headingMatches = (patterns: RegExp[]) =>
    patterns
      .map((pattern) => pattern.exec(normalized))
      .filter((match): match is RegExpExecArray => Boolean(match));
  const starts = headingMatches(requiredHeadings);
  const fallbackStarts = headingMatches(preferredHeadings);
  const startMatch = (starts.length ? starts : fallbackStarts).sort(
    (left, right) => left.index - right.index,
  )[0];
  if (!startMatch) return "";

  const tail = normalized.slice(startMatch.index);
  const endHeadings = [
    /\bworking at\s+[A-Z0-9]/i,
    /\babout us\b/i,
    /\babout the company\b/i,
    /\bcompensation(?: and benefits)?\b/i,
    /\bour benefits\b/i,
    /\bemployee benefits\b/i,
    /\bequal opportunity\b/i,
    /\bhow to apply\b/i,
    /\bapplication process\b/i,
    /\binterview process\b/i,
    /\bwhy (?:join|work with) us\b/i,
    /\bwhat (?:you|you['’]ll) do\b/i,
    /\bresponsibilities\s*:/i,
  ];
  const end = endHeadings
    .map((pattern) => pattern.exec(tail))
    .filter(
      (match): match is RegExpExecArray =>
        Boolean(match && match.index > startMatch[0].length),
    )
    .sort((left, right) => left.index - right.index)[0]?.index;
  return tail.slice(0, end ?? tail.length).trim().slice(0, 20_000);
}

export function extractResponsibilitiesSection(text: string) {
  const normalized = normalizeExtractedText(text).replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const starts = [
    /\bwhat (?:you|you['’]ll) do\b/i,
    /\bkey responsibilities\b/i,
    /\bcore responsibilities\b/i,
    /\bresponsibilities\s*:/i,
  ]
    .map((pattern) => pattern.exec(normalized))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .sort((left, right) => left.index - right.index);
  const start = starts[0];
  if (!start) return "";
  const tail = normalized.slice(start.index);
  const ends = [
    /\bminimum requirements\b/i,
    /\bbasic qualifications\b/i,
    /\brequired qualifications\b/i,
    /\bpreferred qualifications\b/i,
    /\bcandidate requirements\b/i,
    /\brequirements\s*:/i,
    /\bqualifications\s*:/i,
    /\bworking at\s+[A-Z0-9]/i,
    /\bcompensation(?: and benefits)?\b/i,
    /\babout us\b/i,
  ]
    .map((pattern) => pattern.exec(tail))
    .filter(
      (match): match is RegExpExecArray =>
        Boolean(match && match.index > start[0].length),
    )
    .sort((left, right) => left.index - right.index);
  return tail.slice(0, ends[0]?.index ?? tail.length).trim().slice(0, 20_000);
}


export function evidenceGaps(workspace: JobSearchWorkspace, description: string) {
  const skills = workspace.profile.skills.join(" ").toLowerCase();
  const gaps = [
    ["kubernetes", "Kubernetes evidence is not explicit in the supplied sources"],
    ["golang", "Go production experience is not explicit in the supplied sources"],
    ["python", "Python production experience is not explicit in the supplied sources"],
  ] as const;
  return gaps
    .filter(([term]) => description.toLowerCase().includes(term) && !skills.includes(term))
    .map(([, gap]) => gap)
    .slice(0, 3);
}

export function evidenceBackedCoverLetter(
  job: JobOpportunity,
  workspace: JobSearchWorkspace,
) {
  const evidence = workspace.sources
    .flatMap((source) => source.insights)
    .slice(0, 3)
    .map((insight) => insight.summary)
    .filter(Boolean);
  return `Dear ${job.company} hiring team,\n\nI am applying for the ${job.title} role. ${workspace.profile.summary || workspace.profile.headline}\n\n${evidence.join(" ")}\n\nI would welcome the opportunity to discuss how this evidence maps to your requirements.\n\nSincerely,\n${workspace.profile.name}`;
}

export function cvName(workspace: JobSearchWorkspace) {
  return workspace.sources.find((source) => source.kind === "cv")?.name || "";
}

export function sourceProfileUrl(workspace: JobSearchWorkspace, marker: string) {
  const text = workspace.sources
    .map((source) => `${source.url || ""}\n${source.content || ""}`)
    .join("\n");
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp(`(?:https?:\\/\\/)?(?:www\\.)?${escaped}[^\\s,;|)]+`, "i"),
  )?.[0];
  if (!match) return "";
  return /^https?:\/\//i.test(match) ? match : `https://${match}`;
}
