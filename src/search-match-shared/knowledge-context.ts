import { readFile } from "node:fs/promises";
import path from "node:path";
import type { JobOpportunity } from "../contracts/job-search.js";
import type { Capability } from "../contracts/evidence.js";
import type {
  EvidenceKnowledgeIndex,
  KnowledgePageIndexEntry,
} from "../01-evidence-ingestion/04-verification/knowledge-base/index.js";

export interface Phase2KnowledgePage extends KnowledgePageIndexEntry {
  content: string;
}

export interface Phase2KnowledgeRoute extends Phase2KnowledgePage {
  score: number;
}

interface KnowledgeRoutingContext {
  capabilities: Capability[];
  searchLanes: Array<{
    canonicalTitle: string;
    titleAliases: string[];
    leadingCapabilities: string[];
  }>;
  knowledgePages: Phase2KnowledgePage[];
}

const RETRIEVAL_STOPWORDS = new Set([
  "and",
  "are",
  "build",
  "building",
  "candidate",
  "code",
  "complex",
  "deliver",
  "engineer",
  "engineering",
  "experience",
  "for",
  "from",
  "have",
  "own",
  "production",
  "required",
  "requires",
  "responsible",
  "role",
  "senior",
  "software",
  "system",
  "systems",
  "technical",
  "the",
  "with",
]);

export async function loadEvidenceKnowledgePages(
  dataRoot: string,
  candidateId: string,
  evidenceRunId: string,
): Promise<Phase2KnowledgePage[]> {
  const knowledgeRoot = path.resolve(
    dataRoot,
    "job-search",
    "runs",
    candidateId,
    "evidence-runs",
    evidenceRunId,
    "knowledge",
  );
  try {
    const index = JSON.parse(
      await readFile(path.join(knowledgeRoot, "index.json"), "utf8"),
    ) as Partial<EvidenceKnowledgeIndex>;
    if (index.schemaVersion !== "1.0" || !Array.isArray(index.pages)) return [];
    const pages = await Promise.all(
      index.pages.flatMap((entry) =>
        validKnowledgeIndexEntry(entry)
          ? [readKnowledgePage(knowledgeRoot, entry)]
          : [],
      ),
    );
    return pages.flatMap((page) => (page ? [page] : []));
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

export function retrieveKnowledgeRoutes(
  context: KnowledgeRoutingContext,
  opportunities: Array<Pick<JobOpportunity, "id" | "title" | "summary" | "description">>,
  maximumPagesPerJob = 3,
) {
  const capabilityClaimsByName = new Map(
    context.capabilities.map((capability) => [
      normalizeKnowledgeText(capability.name),
      new Set(capability.claimIds),
    ]),
  );
  return opportunities.map((opportunity) => {
    const jobText = `${opportunity.title} ${opportunity.summary} ${opportunity.description || ""}`;
    const jobTokens = knowledgeTokens(jobText);
    const alignedRoleClaims = new Set(
      context.searchLanes
        .filter((lane) => {
          const laneTitle = `${lane.canonicalTitle} ${lane.titleAliases.join(" ")}`;
          return (
            knowledgeOverlap(jobTokens, knowledgeTokens(laneTitle)) >= 2 ||
            lane.titleAliases
              .concat(lane.canonicalTitle)
              .some((title) =>
                normalizeKnowledgeText(jobText).includes(
                  normalizeKnowledgeText(title),
                ),
              )
          );
        })
        .flatMap((lane) =>
          lane.leadingCapabilities.flatMap(
            (name) => [
              ...(capabilityClaimsByName.get(normalizeKnowledgeText(name)) || []),
            ],
          ),
        ),
    );
    const pages = context.knowledgePages
      .filter((page) => page.type === "capability")
      .map((page) => {
        const titleOverlap = knowledgeOverlap(
          jobTokens,
          knowledgeTokens(page.title),
        );
        const summaryOverlap = knowledgeOverlap(
          jobTokens,
          knowledgeTokens(page.summary),
        );
        const keywordOverlap = knowledgeOverlap(
          jobTokens,
          knowledgeTokens(page.keywords.join(" ")),
        );
        const phraseHits = page.keywords.filter((keyword) => {
          const phrase = normalizeKnowledgeText(keyword);
          return (
            phrase.includes(" ") &&
            normalizeKnowledgeText(jobText).includes(phrase)
          );
        }).length;
        const roleBonus = page.claimIds.some((claimId) =>
          alignedRoleClaims.has(claimId),
        )
          ? 6
          : 0;
        const score =
          titleOverlap * 9 +
          keywordOverlap * 3 +
          summaryOverlap * 2 +
          phraseHits * 5 +
          roleBonus;
        return {
          ...page,
          content: selectKnowledgeExcerpt(page.content, jobText, 10_000),
          score,
          hasSubstantiveMatch:
            titleOverlap > 0 ||
            keywordOverlap >= 2 ||
            phraseHits > 0 ||
            roleBonus > 0,
        };
      })
      .filter((page) => page.hasSubstantiveMatch && page.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.claimIds.length - left.claimIds.length ||
          left.title.localeCompare(right.title),
      )
      .slice(0, Math.max(0, maximumPagesPerJob))
      .map(({ hasSubstantiveMatch: _hasSubstantiveMatch, ...page }) => page);
    return { jobId: opportunity.id, pages };
  });
}

export function selectKnowledgeExcerpt(
  content: string,
  query: string,
  maximumCharacters = 12_000,
) {
  const limit = Math.max(500, maximumCharacters);
  if (content.length <= limit) return content;
  const queryTokens = knowledgeTokens(query);
  const paragraphs = content
    .split(/\n{2,}/)
    .map((value, index) => ({ value: value.trim(), index }))
    .filter((item) => item.value);
  const ranked = paragraphs
    .map((item) => ({
      ...item,
      score: knowledgeOverlap(queryTokens, knowledgeTokens(item.value)),
    }))
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.index - right.index,
    );
  const selected: typeof ranked = [];
  let length = 0;
  for (const item of ranked) {
    if (selected.length >= 24) break;
    const addedLength = item.value.length + 2;
    if (length + addedLength > limit && selected.length > 0) continue;
    selected.push(item);
    length += addedLength;
    if (length >= limit) break;
  }
  if (selected.length === 0) return `${content.slice(0, limit).trim()}\n`;
  return `${selected
    .sort((left, right) => left.index - right.index)
    .map((item) => item.value)
    .join("\n\n")
    .slice(0, limit)
    .trim()}\n`;
}

export function knowledgeOverlap(left: Set<string>, right: Set<string>) {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

export function knowledgeTokens(value: string) {
  return new Set(
    normalizeKnowledgeText(value)
      .split(/[^a-z0-9+#.]+/)
      .map(canonicalToken)
      .filter(
        (token) => token.length >= 3 && !RETRIEVAL_STOPWORDS.has(token),
      ),
  );
}

export function normalizeKnowledgeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function readKnowledgePage(
  knowledgeRoot: string,
  entry: KnowledgePageIndexEntry,
): Promise<Phase2KnowledgePage | undefined> {
  const absolute = path.resolve(knowledgeRoot, entry.path);
  if (
    absolute !== knowledgeRoot &&
    !absolute.startsWith(`${knowledgeRoot}${path.sep}`)
  )
    return undefined;
  try {
    return {
      ...entry,
      content: (await readFile(absolute, "utf8")).slice(0, 200_000),
    };
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function validKnowledgeIndexEntry(
  value: unknown,
): value is KnowledgePageIndexEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<KnowledgePageIndexEntry>;
  return (
    typeof entry.id === "string" &&
    (entry.type === "overview" ||
      entry.type === "capability" ||
      entry.type === "source") &&
    typeof entry.title === "string" &&
    typeof entry.path === "string" &&
    typeof entry.summary === "string" &&
    Array.isArray(entry.keywords) &&
    entry.keywords.every((item) => typeof item === "string") &&
    Array.isArray(entry.claimIds) &&
    entry.claimIds.every((item) => typeof item === "string") &&
    Array.isArray(entry.sourceIds) &&
    entry.sourceIds.every((item) => typeof item === "string")
  );
}

function canonicalToken(value: string) {
  if (value === "js") return "javascript";
  if (value === "ts") return "typescript";
  return value;
}

function isMissingFile(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
