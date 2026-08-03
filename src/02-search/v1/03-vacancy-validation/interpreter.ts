import type { CodexExecClient } from "../../../codex-runtime/client.js";
import { productionModel } from "../../../codex-runtime/call-manifest.js";
import {
  buildInput as buildListingExtractionInput,
  command as LISTING_EXTRACTION_COMMAND,
  outputSchema as listingVacancySchema,
  rolePrompt as LISTING_EXTRACTION_ROLE_PROMPT,
  type ListingExtractionOutput,
} from "./llm-calls/01-listing-extraction/index.js";
import {
  buildInput as buildVacancyVerificationInput,
  command as VACANCY_VERIFICATION_COMMAND,
  outputSchema as vacancyInterpretationSchema,
  rolePrompt as VACANCY_VERIFICATION_ROLE_PROMPT,
  type VacancyVerificationOutput,
} from "./llm-calls/02-vacancy-verification/index.js";

export interface VacancyPageSnapshot {
  pageUrl: string;
  pageTitle: string;
  metaDescription: string;
  h1: string;
  headings: string[];
  bodyText: string;
  applyLinks: Array<{ text: string; url: string }>;
  links: Array<{ text: string; url: string }>;
  structured: {
    hasJobPosting: boolean;
    title: string;
    company: string;
    location: string;
    workplaceType: string;
    employmentType: string;
    description: string;
    datePosted: string;
    validThrough: string;
    applyUrl: string;
  };
}

export interface ListingVacancyLead {
  title: string;
  company: string;
  location: string;
  workplaceType: string;
  employmentType: string;
  description: string;
  compensation: string;
  jobUrl: string;
  applyUrl: string;
  openStatus: "open" | "probably_open" | "unknown" | "closed";
  publishedAt: string;
  validThrough: string;
  evidence: Array<{ field: string; sourceText: string }>;
}

export interface VacancyInterpretation {
  pageType: "vacancy" | "job_list" | "company_page" | "closed_job" | "blocked" | "unknown";
  openStatus: "open" | "probably_open" | "unknown" | "closed";
  title: string;
  company: string;
  location: string;
  workplaceType: string;
  employmentType: string;
  description: string;
  compensation: string;
  applyUrl: string;
  publishedAt: string;
  validThrough: string;
  confidence: number;
  ambiguities: string[];
  evidence: Array<{
    field: string;
    sourceText: string;
  }>;
}

export function structuredVacancyIsComplete(snapshot: VacancyPageSnapshot) {
  const job = snapshot.structured;
  return Boolean(
    job.hasJobPosting &&
      job.title.trim() &&
      job.company.trim() &&
      job.description.trim().length >= 120,
  );
}

export function interpretationFromStructuredData(
  snapshot: VacancyPageSnapshot,
): VacancyInterpretation {
  const job = snapshot.structured;
  const expired = isExpired(job.validThrough);
  return {
    pageType: expired ? "closed_job" : "vacancy",
    openStatus: expired ? "closed" : job.applyUrl ? "open" : "probably_open",
    title: job.title,
    company: job.company,
    location: job.location,
    workplaceType: job.workplaceType,
    employmentType: job.employmentType,
    description: job.description,
    compensation: "",
    applyUrl: job.applyUrl,
    publishedAt: job.datePosted,
    validThrough: job.validThrough,
    confidence: 100,
    ambiguities: [],
    evidence: [
      { field: "title", sourceText: job.title },
      { field: "company", sourceText: job.company },
      { field: "description", sourceText: job.description.slice(0, 500) },
    ],
  };
}

export async function extractVacancyLeadsFromListing(
  codex: CodexExecClient,
  cwd: string,
  snapshot: VacancyPageSnapshot,
  candidateIntent: {
    location: string;
    workplace: string;
    employmentTypes: string;
    skills: string[];
    summary: string;
  },
  limit = 8,
): Promise<ListingVacancyLead[]> {
  const runtime = await codex.start();
  const model = productionModel(LISTING_EXTRACTION_COMMAND, runtime.model);
  const thread = await codex.startThread({
    cwd,
    callId: "search.listing-extraction",
    role: LISTING_EXTRACTION_COMMAND.role,
    sandbox: "read-only",
    model,
    approvalPolicy: LISTING_EXTRACTION_COMMAND.approvalPolicy,
    developerInstructions: LISTING_EXTRACTION_ROLE_PROMPT,
  });
  const boundedLimit = Math.max(1, Math.min(limit, 50));
  const result = await codex.runTurn({
    threadId: thread.id,
    cwd,
    sandbox: LISTING_EXTRACTION_COMMAND.sandbox,
    model,
    effort: LISTING_EXTRACTION_COMMAND.effort,
    timeoutMs: LISTING_EXTRACTION_COMMAND.timeoutMs,
    outputSchema: listingVacancySchema,
    prompt: buildListingExtractionInput({
      snapshot,
      candidateIntent,
      limit: boundedLimit,
    }),
  });
  const parsed = JSON.parse(result.finalText) as ListingExtractionOutput;
  return parsed.jobs.filter((lead) => validateListingVacancyLead(snapshot, lead).passed);
}

export function validateListingVacancyLead(
  snapshot: VacancyPageSnapshot,
  lead: ListingVacancyLead,
) {
  const failures: string[] = [];
  if (!lead.title.trim()) failures.push("Vacancy title is missing");
  if (lead.openStatus === "closed") failures.push("Vacancy is closed");
  if (!snapshotContainsUrl(snapshot, lead.jobUrl))
    failures.push("Vacancy URL was not present in the captured page");
  if (lead.applyUrl && !snapshotContainsUrl(snapshot, lead.applyUrl))
    failures.push("Application URL was not present in the captured page");
  if (isExpired(lead.validThrough)) failures.push("Vacancy valid-through date has passed");
  const corpus = snapshotCorpus(snapshot);
  for (const item of lead.evidence) {
    if (
      item.sourceText.trim() &&
      !evidenceAppearsInCorpus(corpus, item.sourceText) &&
      !listingFieldIsSupported(snapshot, lead, item.field)
    )
      failures.push(`Evidence for ${item.field} was not found in the captured page`);
  }
  return { passed: failures.length === 0, failures };
}

export async function interpretVacancySnapshot(
  codex: CodexExecClient,
  cwd: string,
  snapshot: VacancyPageSnapshot,
  lead: {
    title: string;
    company: string;
    location: string;
    applyUrl: string;
  },
): Promise<VacancyInterpretation> {
  const runtime = await codex.start();
  const model = productionModel(VACANCY_VERIFICATION_COMMAND, runtime.model);
  const thread = await codex.startThread({
    cwd,
    callId: "search.vacancy-verification",
    role: VACANCY_VERIFICATION_COMMAND.role,
    sandbox: "read-only",
    model,
    approvalPolicy: VACANCY_VERIFICATION_COMMAND.approvalPolicy,
    developerInstructions: VACANCY_VERIFICATION_ROLE_PROMPT,
  });
  const result = await codex.runTurn({
    threadId: thread.id,
    cwd,
    sandbox: VACANCY_VERIFICATION_COMMAND.sandbox,
    model,
    effort: VACANCY_VERIFICATION_COMMAND.effort,
    timeoutMs: VACANCY_VERIFICATION_COMMAND.timeoutMs,
    outputSchema: vacancyInterpretationSchema,
    prompt: buildVacancyVerificationInput({ snapshot, lead }),
  });
  return JSON.parse(result.finalText) as VacancyVerificationOutput;
}

export function validateVacancyInterpretation(
  snapshot: VacancyPageSnapshot,
  interpretation: VacancyInterpretation,
) {
  const failures: string[] = [];
  if (interpretation.pageType !== "vacancy")
    failures.push(`Page classified as ${interpretation.pageType}`);
  if (interpretation.openStatus === "closed") failures.push("Vacancy is closed");
  if (!interpretation.title.trim()) failures.push("Vacancy title is missing");
  if (!interpretation.company.trim()) failures.push("Employer is missing");
  if (interpretation.description.trim().length < 120)
    failures.push("Vacancy description is too short");
  if (interpretation.confidence < 55)
    failures.push(`Vacancy interpretation confidence is only ${interpretation.confidence}`);
  if (interpretation.applyUrl && !snapshotContainsUrl(snapshot, interpretation.applyUrl))
    failures.push("Application URL was not present in the captured page");
  const corpus = snapshotCorpus(snapshot);
  const validThroughEvidence = interpretation.evidence.find(
    (item) =>
      item.field === "validThrough" &&
      evidenceAppearsInCorpus(corpus, item.sourceText),
  );
  if (
    isExpired(interpretation.validThrough) &&
    (snapshot.structured.validThrough.trim() || validThroughEvidence)
  )
    failures.push("Vacancy valid-through date has passed");
  for (const item of interpretation.evidence) {
    if (["publishedAt", "validThrough", "compensation"].includes(item.field))
      continue;
    if (
      item.sourceText.trim() &&
      !evidenceAppearsInCorpus(corpus, item.sourceText) &&
      !interpretationFieldIsSupported(snapshot, interpretation, item.field)
    )
      failures.push(`Evidence for ${item.field} was not found in the captured page`);
  }
  return { passed: failures.length === 0, failures };
}

function snapshotContainsUrl(snapshot: VacancyPageSnapshot, value: string) {
  try {
    const normalized = normalizeUrl(value);
    return [
      snapshot.pageUrl,
      snapshot.structured.applyUrl,
      ...snapshot.applyLinks.map((item) => item.url),
      ...snapshot.links.map((item) => item.url),
    ]
      .filter(Boolean)
      .some((item) => normalizeUrl(item) === normalized);
  } catch {
    return false;
  }
}

function snapshotCorpus(snapshot: VacancyPageSnapshot) {
  return normalize(
    [
      snapshot.pageUrl,
      snapshot.pageTitle,
      snapshot.metaDescription,
      snapshot.h1,
      ...snapshot.headings,
      snapshot.bodyText,
      snapshot.structured.title,
      snapshot.structured.company,
      snapshot.structured.location,
      snapshot.structured.workplaceType,
      snapshot.structured.employmentType,
      snapshot.structured.description,
      snapshot.structured.applyUrl,
      ...snapshot.applyLinks.flatMap((item) => [item.text, item.url]),
      ...snapshot.links.flatMap((item) => [item.text, item.url]),
    ].join(" "),
  );
}

function normalizeUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  return url.toString().replace(/\/$/, "").toLowerCase();
}

function normalize(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function evidenceAppearsInCorpus(corpus: string, sourceText: string) {
  const candidates = [sourceText];
  for (const match of sourceText.matchAll(/["“”]([^"“”]{8,})["“”]/g))
    candidates.push(match[1]);
  for (const url of sourceText.match(/https?:\/\/[^\s"'\]}]+/gi) || [])
    candidates.push(url);
  return candidates
    .map((candidate) => normalize(candidate).replace(/^[^a-z0-9]+|[^a-z0-9/]+$/g, ""))
    .filter((candidate) => candidate.length >= 8)
      .some((candidate) => corpus.includes(candidate));
}

function listingFieldIsSupported(
  snapshot: VacancyPageSnapshot,
  lead: ListingVacancyLead,
  field: string,
) {
  const values: Record<string, string> = {
    title: lead.title,
    company: lead.company,
    location: lead.location,
    workplaceType: lead.workplaceType,
    employmentType: lead.employmentType,
    description: lead.description,
    compensation: lead.compensation,
    publishedAt: lead.publishedAt,
    validThrough: lead.validThrough,
  };
  if (field === "jobUrl") return snapshotContainsUrl(snapshot, lead.jobUrl);
  if (field === "applyUrl")
    return Boolean(lead.applyUrl) && snapshotContainsUrl(snapshot, lead.applyUrl);
  if (field === "openStatus") return pageShowsAnOpenApplication(snapshot);
  return valueIsSupported(snapshotCorpus(snapshot), values[field] ?? "", field);
}

function interpretationFieldIsSupported(
  snapshot: VacancyPageSnapshot,
  interpretation: VacancyInterpretation,
  field: string,
) {
  const values: Record<string, string> = {
    title: interpretation.title,
    company: interpretation.company,
    location: interpretation.location,
    workplaceType: interpretation.workplaceType,
    employmentType: interpretation.employmentType,
    description: interpretation.description,
    compensation: interpretation.compensation,
    publishedAt: interpretation.publishedAt,
    validThrough: interpretation.validThrough,
  };
  if (field === "applyUrl")
    return (
      Boolean(interpretation.applyUrl) &&
      snapshotContainsUrl(snapshot, interpretation.applyUrl)
    );
  if (field === "openStatus") return pageShowsAnOpenApplication(snapshot);
  if (field === "pageType")
    return Boolean(
      interpretation.pageType === "vacancy" &&
        interpretation.title.trim() &&
        interpretation.description.trim().length >= 120,
    );
  return valueIsSupported(snapshotCorpus(snapshot), values[field] ?? "", field);
}

function pageShowsAnOpenApplication(snapshot: VacancyPageSnapshot) {
  if (snapshot.applyLinks.length > 0 || snapshot.structured.applyUrl) return true;
  return /\bapply(?: for this job| now)?\b/i.test(
    `${snapshot.bodyText} ${snapshot.headings.join(" ")}`,
  );
}

function valueIsSupported(corpus: string, value: string, field: string) {
  const normalized = normalize(value);
  if (!normalized) return false;
  if (corpus.includes(normalized)) return true;
  const tokens = significantTokens(normalized);
  if (tokens.length === 0) return false;
  const corpusTokens = new Set(significantTokens(corpus));
  const overlap = tokens.filter((token) => corpusTokens.has(token)).length;
  if (field === "description")
    return overlap >= Math.min(8, tokens.length) && overlap / tokens.length >= 0.35;
  return overlap >= Math.min(2, tokens.length) && overlap / tokens.length >= 0.8;
}

function significantTokens(value: string) {
  const stopWords = new Set([
    "and",
    "for",
    "from",
    "into",
    "job",
    "role",
    "the",
    "this",
    "with",
  ]);
  return [
    ...new Set(
      normalize(value)
        .split(/[^a-z0-9+#.]+/)
        .filter((token) => token.length >= 3 && !stopWords.has(token)),
    ),
  ];
}

function isExpired(value: string) {
  if (!value.trim()) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp < Date.now();
}
