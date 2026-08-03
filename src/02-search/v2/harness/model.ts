import { createHash } from "node:crypto";
import type { JobSearchWorkspace } from "../../../contracts/job-search.js";
import type { CodexExecClient } from "../../../codex-runtime/client.js";
import type { Phase2EvidenceContext } from "../../../search-match-shared/evidence-context.js";
import { canonicalOpportunityIsExcluded } from "../../../search-match-shared/evidence-context.js";
import { isPublicWebUrl, normalizeOpportunityUrl } from "../support/url.js";
import type {
  SearchV2Capture,
  SearchV2Decision,
  SearchV2Lead,
} from "../contracts.js";
import type { SearchV2Configuration } from "../config.js";
import { inaccessibleDecision } from "./capture.js";
import {
  buildClassificationPrompt,
  buildSearchPrompt,
  SEARCH_V2_CLASSIFIER_ROLE,
  SEARCH_V2_DISCOVERY_ROLE,
} from "./prompts.js";
import {
  classificationOutputSchema,
  searchOutputSchema,
} from "./schemas.js";

interface RawSearchOutput {
  jobs: Array<{
    title: string;
    company: string;
    location: string;
    workplaceType: string;
    employmentType: string;
    url: string;
    sourceKind: "vacancy" | "job_list";
    query: string;
    sourceClass: string;
    snippet: string;
    compensation: string;
  }>;
}

interface RawClassificationOutput {
  results: SearchV2Decision[];
}

export async function discoverSearchV2Leads(input: {
  codex: CodexExecClient;
  cwd: string;
  workspace: JobSearchWorkspace;
  evidence: Phase2EvidenceContext;
  requested: number;
  wave: number;
  excludedUrls: string[];
  rejectionFeedback: string[];
}): Promise<SearchV2Lead[]> {
  const runtime = await input.codex.start();
  if (!runtime.authenticated)
    throw new Error("Codex is not authenticated for search v2");
  const model =
    process.env.ROLEGAIN_SEARCH_MODEL || runtime.model || "gpt-5.6-luna";
  const output = await runStructured<RawSearchOutput>({
    codex: input.codex,
    cwd: input.cwd,
    role: "search-v2-web-discovery",
    developerInstructions: SEARCH_V2_DISCOVERY_ROLE,
    prompt: buildSearchPrompt(input),
    schema: searchOutputSchema,
    model,
    webSearch: "live",
    timeoutMs: 3 * 60_000,
  });
  const seen = new Set(input.excludedUrls.map(normalizeOpportunityUrl));
  const leads: SearchV2Lead[] = [];
  for (const item of output.jobs) {
    if (canonicalOpportunityIsExcluded(input.evidence, item.title)) continue;
    if (!isPublicWebUrl(item.url)) continue;
    const normalized = normalizeOpportunityUrl(item.url);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    leads.push({
      id: createHash("sha256").update(normalized).digest("hex").slice(0, 20),
      title: clean(item.title),
      company: clean(item.company),
      location: clean(item.location),
      workplaceType: clean(item.workplaceType),
      employmentType: clean(item.employmentType),
      url: item.url.trim(),
      sourceKind: item.sourceKind,
      query: clean(item.query),
      sourceClass: clean(item.sourceClass) || "search_engine",
      snippet: clean(item.snippet),
      compensation: clean(item.compensation),
      wave: input.wave + 1,
    });
  }
  return leads;
}

export async function classifySearchV2Captures(input: {
  codex: CodexExecClient;
  cwd: string;
  captures: SearchV2Capture[];
  configuration: SearchV2Configuration;
}): Promise<SearchV2Decision[]> {
  const decided = new Map<string, SearchV2Decision>();
  const unresolved: SearchV2Capture[] = [];
  for (const capture of input.captures) {
    const inaccessible = inaccessibleDecision(capture);
    if (inaccessible) decided.set(capture.id, inaccessible);
    else unresolved.push(capture);
  }
  if (unresolved.length) {
    const batches = chunk(unresolved, input.configuration.classificationBatchSize);
    const outputs = await mapConcurrent(
      batches,
      input.configuration.classificationConcurrency,
      async (batch) => {
        const runtime = await input.codex.start();
        const model =
          process.env.ROLEGAIN_SEARCH_MODEL || runtime.model || "gpt-5.6-luna";
        return runStructured<RawClassificationOutput>({
          codex: input.codex,
          cwd: input.cwd,
          role: "search-v2-page-classifier",
          developerInstructions: SEARCH_V2_CLASSIFIER_ROLE,
          prompt: buildClassificationPrompt(batch),
          schema: classificationOutputSchema,
          model,
          webSearch: "disabled",
          timeoutMs: 2 * 60_000,
        });
      },
    );
    for (const decision of outputs.flatMap((output) => output.results))
      if (unresolved.some((capture) => capture.id === decision.id))
        decided.set(decision.id, sanitizeDecision(decision));
  }
  return input.captures.map(
    (capture) =>
      decided.get(capture.id) || {
        id: capture.id,
        status: "reject",
        reason: "The v2 classifier did not return this capture.",
        title: capture.lead.title,
        company: capture.lead.company,
        location: capture.lead.location,
        workplaceType: capture.lead.workplaceType,
        employmentType: capture.lead.employmentType,
        applyUrl: capture.finalUrl || capture.suppliedUrl,
        compensation: capture.lead.compensation,
        children: [],
      },
  );
}

async function runStructured<T>(input: {
  codex: CodexExecClient;
  cwd: string;
  role: string;
  developerInstructions: string;
  prompt: string;
  schema: Record<string, unknown>;
  model: string;
  webSearch: "disabled" | "live";
  timeoutMs: number;
}): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const thread = await input.codex.startThread({
        cwd: input.cwd,
        role: input.role,
        sandbox: "read-only",
        model: input.model,
        approvalPolicy: "never",
        webSearch: { mode: input.webSearch },
        developerInstructions: input.developerInstructions,
      });
      const result = await input.codex.runTurn({
        threadId: thread.id,
        prompt: input.prompt,
        cwd: input.cwd,
        sandbox: "readOnly",
        outputSchema: input.schema,
        model: input.model,
        approvalPolicy: "never",
        effort: "low",
        timeoutMs: input.timeoutMs,
      });
      return JSON.parse(result.finalText) as T;
    } catch (error) {
      lastError = error;
      if (
        attempt === 1 ||
        !/capacity|temporar|rate limit|timed out/i.test(
          error instanceof Error ? error.message : String(error),
        )
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
  throw lastError;
}

function sanitizeDecision(decision: SearchV2Decision): SearchV2Decision {
  return {
    ...decision,
    reason: clean(decision.reason),
    title: clean(decision.title),
    company: clean(decision.company),
    location: clean(decision.location),
    workplaceType: clean(decision.workplaceType),
    employmentType: clean(decision.employmentType),
    applyUrl: isPublicWebUrl(decision.applyUrl) ? decision.applyUrl.trim() : "",
    compensation: clean(decision.compensation),
    children: decision.children
      .filter((child) => isPublicWebUrl(child.url) && clean(child.title))
      .map((child) => ({
        title: clean(child.title),
        company: clean(child.company),
        url: child.url.trim(),
      })),
  };
}

function chunk<T>(items: T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, index * size + size),
  );
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}

function clean(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
