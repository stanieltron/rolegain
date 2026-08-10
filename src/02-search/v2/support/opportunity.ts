import { createHash } from "node:crypto";
import type {
  JobOpportunity,
  JobResearchFailure,
  JobSearchWorkspace,
} from "../../../contracts/job-search.js";
import {
  canonicalOpportunityAlignment,
  canonicalStrengthsForTitle,
  type Phase2EvidenceContext,
} from "../../../search-match-shared/evidence-context.js";
import {
  selectedWorkModes,
  willingWorkLocations,
} from "../../../search-match-shared/work-preferences.js";
import type {
  SearchV2Capture,
  SearchV2Decision,
  SearchV2Lead,
} from "../contracts.js";
import { isPublicWebUrl, normalizeOpportunityUrl } from "./url.js";

export function opportunityFromSearchV2(input: {
  capture: SearchV2Capture;
  decision: SearchV2Decision;
  workspace: JobSearchWorkspace;
  evidence: Phase2EvidenceContext;
  searchRunId: string;
}) {
  const { capture, decision, workspace, evidence, searchRunId } = input;
  const description = selectDescription(capture);
  const title =
    clean(decision.title) ||
    clean(capture.jobPosting?.title) ||
    capture.lead.title;
  const company =
    clean(decision.company) ||
    clean(capture.jobPosting?.company) ||
    capture.lead.company ||
    "Unknown employer";
  const location =
    clean(decision.location) ||
    clean(capture.jobPosting?.location) ||
    capture.lead.location ||
    "Not specified";
  const workplace =
    clean(decision.workplaceType) ||
    capture.lead.workplaceType ||
    (remoteSignal(`${location} ${description}`) ? "Remote" : "Not specified");
  const applyUrl = selectApplyUrl(capture, decision);
  const compensation =
    normalizeCompensation(decision.compensation) ||
    normalizeCompensation(capture.lead.compensation) ||
    extractCompensation(description);
  const retrievedAt = new Date().toISOString();
  const sourceConfidence = authoritativeSourceConfidence(
    capture.finalUrl,
    applyUrl,
  );
  const riskSignals = [
    ...(!capture.jobPosting?.datePosted ? ["posting_date_unavailable"] : []),
    ...(normalizeOpportunityUrl(applyUrl) ===
      normalizeOpportunityUrl(capture.finalUrl) &&
    !/\/application|\/apply\b/i.test(applyUrl)
      ? ["application_path_not_distinct"]
      : []),
    ...(description.length < 500 ? ["description_may_be_incomplete"] : []),
  ];
  const opportunity: JobOpportunity = {
    id: `live-${createHash("sha256")
      .update(`${company}:${title}:${capture.finalUrl}`)
      .digest("hex")
      .slice(0, 20)}`,
    evidenceRunId: evidence.evidenceRunId,
    searchRunId,
    company,
    title,
    location,
    workplace,
    compensation: compensation || "Not disclosed",
    sourceUrl: capture.finalUrl || capture.suppliedUrl,
    applyUrl,
    capturedAt: retrievedAt.slice(0, 10),
    lastValidatedAt: retrievedAt,
    fit: canonicalOpportunityAlignment(evidence, { title, description }),
    summary: summarize(description),
    description,
    requirements: extractRequirements(description),
    requirementMatches: [],
    strengths: canonicalStrengthsForTitle(evidence, title),
    gaps: evidenceGaps(workspace, description),
    opportunityConfidence: confidence({
      sourceConfidence,
      applicationPath:
        normalizeOpportunityUrl(applyUrl) !==
          normalizeOpportunityUrl(capture.finalUrl) ||
        /\/application|\/apply\b/i.test(applyUrl),
      complete: description.length >= 500,
      published: Boolean(capture.jobPosting?.datePosted),
      risks: riskSignals.length,
    }),
    validation: {
      status: "live",
      sourceConfidence,
      retrievedAt,
      descriptionFingerprint: createHash("sha256")
        .update(description)
        .digest("hex"),
      responsibilitiesText: extractSection(description, [
        /\bwhat (?:you|you['’]ll) do\b/i,
        /\bkey responsibilities\b/i,
        /\bresponsibilities\s*:/i,
      ]),
      qualificationsText: extractSection(description, [
        /\bminimum requirements\b/i,
        /\brequired qualifications\b/i,
        /\bwhat we['’]re looking for\b/i,
        /\brequirements\s*:/i,
        /\bqualifications\s*:/i,
      ]),
      riskSignals,
    },
    discoveryProvenance: [
      {
        query: capture.lead.query || "search v2",
        wave: capture.lead.wave,
        sourceClass: capture.lead.sourceClass || "search_engine",
        discoveredAt: retrievedAt,
      },
    ],
    sourceGroup: capture.lead.sourceGroup,
  };
  return opportunity;
}

export function searchV2Failure(
  lead: SearchV2Lead,
  reason: string,
): JobResearchFailure {
  const lower = reason.toLowerCase();
  const reasonCode =
    /definite closure signal|explicit closure signal|page explicitly (?:says|states)|page (?:says|states).*(?:closed|expired|filled|no longer (?:available|accepting))|vacancy is (?:closed|expired)|job is (?:closed|expired)|(?:this|the) job is no longer (?:available|accepting)|position is filled|applications? (?:are|is) (?:currently )?closed|valid-through date has passed/.test(
      lower,
    )
    ? "closed_or_unavailable"
    : /workplace or location does not match|location mismatch/.test(lower)
      ? "location_or_workplace"
      : /blocked|403|captcha|access|no usable|inaccessible/.test(lower)
      ? "access_restricted"
      : /duplicate/.test(lower)
        ? "duplicate"
        : /wrong|not.*vacancy|staffing|talent|pool|generic/.test(lower)
          ? "not_a_vacancy"
          : "technical_failure";
  return {
    id: createHash("sha256")
      .update(`${lead.url}:vacancy_validation:${reason}`)
      .digest("hex")
      .slice(0, 20),
    company: lead.company || "Unknown employer",
    title: lead.title || "Unknown position",
    location: lead.location || "Not specified",
    sourceUrl: lead.url,
    applyUrl: lead.url,
    stage: "vacancy_validation",
    disposition:
      reasonCode === "closed_or_unavailable" ||
      reasonCode === "location_or_workplace"
        ? "rejected"
        : reasonCode === "duplicate"
          ? "duplicate"
          : reasonCode === "access_restricted"
            ? "manual_review"
            : "unresolved",
    reasonCode,
    reason,
    capturedAt: new Date().toISOString(),
  };
}

export function canonicalVacancyIdentity(opportunity: JobOpportunity) {
  return [opportunity.company, opportunity.title, opportunity.location]
    .map(normalizeIdentity)
    .join("::");
}

export function matchesSearchV2Workplace(
  opportunity: JobOpportunity,
  workspace: JobSearchWorkspace,
) {
  const modes = selectedWorkModes(workspace.profile.workplace);
  if (!modes.length) return true;
  const remote = remoteSignal(
    `${opportunity.workplace} ${opportunity.location} ${opportunity.description || ""}`,
  );
  if (modes.includes("Remote") && remote) return true;
  if (remote) return false;
  const targets = willingWorkLocations(workspace.profile.targetLocations);
  const location = normalizeIdentity(opportunity.location);
  const locationAllowed = targets.some((target) => {
    const normalized = normalizeIdentity(target.split(",")[0]);
    return normalized.length >= 3 && location.includes(normalized);
  });
  if (!locationAllowed) return false;
  if (modes.includes("Hybrid") && /hybrid/i.test(opportunity.workplace))
    return true;
  return modes.includes("On-site");
}

export async function compensationRatesFor(
  workspace: JobSearchWorkspace,
) {
  if (!/^(EUR|USD|GBP|CHF|CZK|PLN|CAD|AUD)\s+\d+/i.test(
    workspace.profile.salaryExpectation,
  ))
    return { EUR: 1 } as Record<string, number>;
  const response = await fetch(
    "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
    {
      headers: { "user-agent": "RolegainDiscoveryV2/1.0" },
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!response.ok) throw new Error("Could not load ECB exchange rates");
  const xml = await response.text();
  const rates: Record<string, number> = { EUR: 1 };
  for (const match of xml.matchAll(
    /currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g,
  ))
    rates[match[1]] = 1 / Number(match[2]);
  return rates;
}

export function meetsSearchV2CompensationFloor(
  opportunity: JobOpportunity,
  workspace: JobSearchWorkspace,
  eurPerUnit: Record<string, number>,
) {
  const floor = workspace.profile.salaryExpectation.match(
    /^(EUR|USD|GBP|CHF|CZK|PLN|CAD|AUD)\s+(\d+)/i,
  );
  if (!floor) return true;
  const pay = parseCompensation(opportunity.compensation);
  if (!pay) return true;
  const floorRate = eurPerUnit[floor[1].toUpperCase()];
  const payRate = eurPerUnit[pay.currency];
  // An unavailable exchange rate is uncertainty, not proof that the vacancy
  // falls below the candidate's floor. Keep it for matching in that case.
  if (!floorRate || !payRate) return true;
  const floorEur = Number(floor[2]) * floorRate;
  const payEur = pay.amount * (pay.hourly ? 2_080 : 1) * payRate;
  return payEur >= floorEur;
}

function selectDescription(capture: SearchV2Capture) {
  const structured = clean(capture.jobPosting?.description);
  if (structured.length >= 300) return structured;
  const body = capture.body.trim();
  return body || clean(capture.lead.snippet);
}

function selectApplyUrl(
  capture: SearchV2Capture,
  decision: SearchV2Decision,
) {
  const direct = capture.links.find((link) =>
    /\bapply\b/i.test(`${link.text} ${link.url}`),
  )?.url;
  if (
    isPublicWebUrl(decision.applyUrl) &&
    (normalizeOpportunityUrl(decision.applyUrl) !==
      normalizeOpportunityUrl(capture.finalUrl) ||
      /\/application|\/apply\b/i.test(decision.applyUrl))
  )
    return decision.applyUrl;
  return isPublicWebUrl(direct || "")
    ? direct!
    : isPublicWebUrl(decision.applyUrl)
      ? decision.applyUrl
      : capture.finalUrl || capture.suppliedUrl;
}

function authoritativeSourceConfidence(jobUrl: string, applyUrl: string) {
  try {
    const job = new URL(jobUrl);
    const apply = new URL(applyUrl);
    if (
      /(?:ashbyhq\.com|greenhouse\.io|lever\.co|myworkdayjobs\.com|smartrecruiters\.com)$/i.test(
        job.hostname,
      ) ||
      /(?:ashbyhq\.com|greenhouse\.io|lever\.co|myworkdayjobs\.com|smartrecruiters\.com)$/i.test(
        apply.hostname,
      )
    )
      return 0.95;
    return job.hostname === apply.hostname ? 0.9 : 0.75;
  } catch {
    return 0.5;
  }
}

function confidence(input: {
  sourceConfidence: number;
  applicationPath: boolean;
  complete: boolean;
  published: boolean;
  risks: number;
}) {
  return Math.round(
    Math.max(
      0,
      Math.min(
        1,
        input.sourceConfidence * 0.4 +
          (input.applicationPath ? 0.25 : 0) +
          (input.complete ? 0.2 : 0) +
          (input.published ? 0.05 : 0) +
          0.1 -
          Math.min(0.2, input.risks * 0.05),
      ),
    ) * 1000,
  ) / 1000;
}

function extractRequirements(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^[-•*]\s*/, "").trim())
    .filter((line) => line.length >= 25 && line.length <= 240)
    .filter((line) =>
      /experience|ability|proficien|knowledge|strong|expert|years|required/i.test(
        line,
      ),
    )
    .slice(0, 10);
}

function extractSection(text: string, starts: RegExp[]) {
  const normalized = clean(text);
  const match = starts
    .map((pattern) => pattern.exec(normalized))
    .filter((item): item is RegExpExecArray => Boolean(item))
    .sort((left, right) => left.index - right.index)[0];
  return match ? normalized.slice(match.index, match.index + 6_000) : "";
}

function evidenceGaps(workspace: JobSearchWorkspace, description: string) {
  const skills = workspace.profile.skills.join(" ").toLowerCase();
  return [
    ["kubernetes", "Kubernetes evidence is not explicit in the supplied sources"],
    ["golang", "Go production experience is not explicit in the supplied sources"],
    ["python", "Python production experience is not explicit in the supplied sources"],
  ]
    .filter(([term]) => description.toLowerCase().includes(term) && !skills.includes(term))
    .map(([, gap]) => gap)
    .slice(0, 3);
}

function extractCompensation(text: string) {
  return text
    .split(/\n+/)
    .map(clean)
    .find((line) =>
      /(?:salary|compensation|pay range).{0,100}(?:EUR|USD|GBP|CHF|CZK|PLN|CAD|AUD|€|\$|£)\s*[\d.]+/i.test(
        line,
      ),
    ) || "";
}

function normalizeCompensation(value: string) {
  const text = clean(value);
  return parseCompensation(text) ? text.slice(0, 900) : "";
}

function parseCompensation(value: string) {
  const match = value.replace(/,/g, "").match(
    /(EUR|USD|GBP|CHF|CZK|PLN|CAD|AUD|€|\$|£)\s*([\d.]+)\s*([kK])?/i,
  );
  if (!match) return undefined;
  return {
    currency:
      match[1] === "€" ? "EUR" : match[1] === "$" ? "USD" : match[1] === "£" ? "GBP" : match[1].toUpperCase(),
    amount: Number(match[2]) * (match[3] ? 1_000 : 1),
    hourly: /(?:\/|per\s+)h(?:ou)?r/i.test(value),
  };
}

function summarize(value: string) {
  return clean(value).slice(0, 360) || "Live vacancy validated by search v2.";
}

function remoteSignal(value: string) {
  return /\bremote(?:ly)?\b|work(?:ing)? from (?:home|anywhere)|worldwide/i.test(
    value,
  );
}

function normalizeIdentity(value: string) {
  return clean(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function clean(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
