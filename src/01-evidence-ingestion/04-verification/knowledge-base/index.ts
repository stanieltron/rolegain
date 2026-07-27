import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CandidateUnknown,
  Capability,
  EvidenceClaim,
  ProhibitedInference,
  RoleFamily,
  SourceSnapshot,
} from "../../../contracts/evidence.js";
import type {
  CandidateSource,
  JobSearchWorkspace,
} from "../../../contracts/job-search.js";
import type { CandidateAnalysisResult } from "../../types.js";

export interface KnowledgePageIndexEntry {
  id: string;
  type: "overview" | "capability" | "source";
  title: string;
  path: string;
  summary: string;
  keywords: string[];
  claimIds: string[];
  sourceIds: string[];
}

export interface EvidenceKnowledgeIndex {
  schemaVersion: "1.0";
  entryPoint: "START_HERE.md";
  pages: KnowledgePageIndexEntry[];
}

export interface EvidenceKnowledgeBase {
  index: EvidenceKnowledgeIndex;
  files: Array<{ path: string; content: string }>;
}

interface KnowledgeTopic {
  id: string;
  name: string;
  aliases: string[];
  claims: EvidenceClaim[];
  capability?: Capability;
}

export function buildEvidenceKnowledgeBase(input: {
  workspace: JobSearchWorkspace;
  analysis: CandidateAnalysisResult;
  snapshots: SourceSnapshot[];
  claims: EvidenceClaim[];
  capabilities: Capability[];
  roleFamilies: RoleFamily[];
  unknowns: CandidateUnknown[];
  prohibitedInferences: ProhibitedInference[];
}): EvidenceKnowledgeBase {
  const {
    workspace,
    analysis,
    snapshots,
    claims,
    capabilities,
    roleFamilies,
    unknowns,
    prohibitedInferences,
  } = input;
  const sourcePaths = new Map(
    workspace.sources.map((source) => [
      source.id,
      `sources/${knowledgeSourceFilename(source)}`,
    ]),
  );
  const activeClaims = claims.filter((claim) => claim.status === "active");
  const topics = knowledgeTopics(capabilities, activeClaims);
  const sourcePages = workspace.sources.map((source) => {
    const sourceClaims = activeClaims.filter((claim) =>
      claim.sourceRefs.some((ref) => ref.sourceId === source.id),
    );
    const sourceAnalysis = analysis.sourceInsights.find(
      (item) => item.sourceId === source.id,
    );
    const snapshot = snapshots.find((item) => item.sourceId === source.id);
    const relativePath = sourcePaths.get(source.id)!;
    return {
      path: relativePath,
      content: renderSourcePage({
        source,
        snapshot,
        sourceClaims,
        knowledgeMarkdown: sourceAnalysis?.knowledgeMarkdown,
        insights: sourceAnalysis?.insights || [],
        unknowns: unknowns.filter((item) => item.sourceIds.includes(source.id)),
        prohibitedInferences: prohibitedInferences.filter((item) =>
          item.sourceIds.includes(source.id),
        ),
      }),
      index: {
        id: `source:${source.id}`,
        type: "source" as const,
        title: source.name,
        path: relativePath,
        summary: sourceSummary(source, sourceClaims),
        keywords: pageKeywords([
          source.name,
          source.kind,
          ...sourceClaims.flatMap(claimKeywords),
        ]),
        claimIds: sourceClaims.map((claim) => claim.claimId),
        sourceIds: [source.id],
      },
    };
  });
  const capabilityPages = topics.map((topic) => {
    const relativePath = `topics/${slug(topic.name)}.md`;
    const sourceIds = unique(
      topic.claims.flatMap((claim) =>
        claim.sourceRefs.map((ref) => ref.sourceId),
      ),
    );
    return {
      path: relativePath,
      content: renderCapabilityPage(topic, sourcePaths, workspace.sources),
      index: {
        id: topic.id,
        type: "capability" as const,
        title: topic.name,
        path: relativePath,
        summary: capabilitySummary(topic),
        keywords: pageKeywords([
          topic.name,
          ...topic.aliases,
          ...topic.claims.flatMap(claimKeywords),
        ]),
        claimIds: topic.claims.map((claim) => claim.claimId),
        sourceIds,
      },
    };
  });
  const overviewEntry: KnowledgePageIndexEntry = {
    id: "overview",
    type: "overview",
    title: "Candidate evidence overview",
    path: "START_HERE.md",
    summary:
      workspace.profile.summary ||
      `Evidence-backed knowledge base for ${workspace.profile.name || "the candidate"}.`,
    keywords: pageKeywords([
      workspace.profile.headline,
      ...workspace.profile.skills,
      ...roleFamilies.flatMap((role) => [
        role.canonicalTitle,
        ...role.titleAliases,
        ...role.problemPhrases,
      ]),
    ]),
    claimIds: activeClaims.map((claim) => claim.claimId),
    sourceIds: workspace.sources.map((source) => source.id),
  };
  const index: EvidenceKnowledgeIndex = {
    schemaVersion: "1.0",
    entryPoint: "START_HERE.md",
    pages: [
      overviewEntry,
      ...capabilityPages.map((page) => page.index),
      ...sourcePages.map((page) => page.index),
    ],
  };
  const files = [
    {
      path: "START_HERE.md",
      content: renderStartHere({
        workspace,
        claims: activeClaims,
        topics,
        roleFamilies,
        unknowns,
        sourcePaths,
      }),
    },
    {
      path: "index.json",
      content: `${JSON.stringify(index, null, 2)}\n`,
    },
    ...capabilityPages.map(({ path: pagePath, content }) => ({
      path: pagePath,
      content,
    })),
    ...sourcePages.map(({ path: pagePath, content }) => ({
      path: pagePath,
      content,
    })),
  ];
  return { index, files };
}

export async function writeEvidenceKnowledgeBase(
  runDirectory: string,
  knowledge: EvidenceKnowledgeBase,
) {
  const knowledgeRoot = path.join(runDirectory, "knowledge");
  await Promise.all(
    knowledge.files.map(async (file) => {
      const destination = path.join(knowledgeRoot, file.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content, "utf8");
    }),
  );
}

export function knowledgeSourceFilename(source: CandidateSource) {
  return `${slug(source.name)}-${source.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12)}.md`;
}

function knowledgeTopics(
  capabilities: Capability[],
  claims: EvidenceClaim[],
): KnowledgeTopic[] {
  const topics = new Map<string, KnowledgeTopic>();
  const rankedCapabilities = capabilities
    .map((capability) => ({
      capability,
      claims: claims.filter((claim) =>
        capability.claimIds.includes(claim.claimId),
      ),
    }))
    .sort(
      (left, right) =>
        evidenceScore(right.claims) - evidenceScore(left.claims) ||
        left.capability.name.localeCompare(right.capability.name),
    );
  for (const { capability, claims: capabilityClaims } of rankedCapabilities) {
    addTopic(topics, {
      id: `capability:${capability.capabilityId}`,
      name: capability.name,
      aliases: [
        ...capability.directAliases,
        ...capability.adjacentAliases,
        ...capability.toolsMethods,
        ...topicAliases(capability.name),
      ],
      claims: capabilityClaims,
      capability,
    });
  }

  return [...topics.values()]
    .filter((topic) => topic.claims.length > 0)
    .sort(
      (left, right) =>
        evidenceScore(right.claims) - evidenceScore(left.claims) ||
        left.name.localeCompare(right.name),
    );
}

function addTopic(topics: Map<string, KnowledgeTopic>, candidate: KnowledgeTopic) {
  const key = normalize(candidate.name);
  if (!key || !isKnowledgeTopic(candidate.name)) return;
  const existing = topics.get(key);
  if (!existing) {
    topics.set(key, {
      ...candidate,
      aliases: unique(candidate.aliases),
      claims: uniqueObjects(candidate.claims, (claim) => claim.claimId),
    });
    return;
  }
  existing.aliases = unique([...existing.aliases, ...candidate.aliases]);
  existing.claims = uniqueObjects(
    [...existing.claims, ...candidate.claims],
    (claim) => claim.claimId,
  );
  existing.capability ||= candidate.capability;
}

function renderStartHere(input: {
  workspace: JobSearchWorkspace;
  claims: EvidenceClaim[];
  topics: KnowledgeTopic[];
  roleFamilies: RoleFamily[];
  unknowns: CandidateUnknown[];
  sourcePaths: Map<string, string>;
}) {
  const { workspace, claims, topics, roleFamilies, unknowns, sourcePaths } =
    input;
  const supported = claims.filter(
    (claim) => claim.supportStatus === "supported",
  ).length;
  const lines = [
    `# ${workspace.profile.name || "Candidate"} evidence knowledge base`,
    "",
    workspace.profile.headline
      ? `**${workspace.profile.headline}**`
      : "**Evidence-backed candidate profile**",
    "",
    workspace.profile.summary ||
      "This directory provides a layered, human-readable view of the canonical evidence ledger.",
    "",
    "## How to use this knowledge base",
    "",
    "1. Start here for orientation.",
    "2. Use `index.json` to route a requirement to relevant topic pages.",
    "3. Follow topic pages to source pages for deep context.",
    "4. Treat canonical claim IDs and their exact quotations as authoritative; narrative notes are retrieval aids.",
    "",
    "## Evidence at a glance",
    "",
    `- Sources: ${workspace.sources.length}`,
    `- Active canonical claims: ${claims.length}`,
    `- Exactly supported claims: ${supported}`,
    `- Topic pages: ${topics.length}`,
    "",
    "## Topic routes",
    "",
    ...topics.map(
      (topic) =>
        `- [${topic.name}](./topics/${slug(topic.name)}.md) - ${topic.claims.length} linked claim${topic.claims.length === 1 ? "" : "s"}`,
    ),
    "",
    "## Role-family routes",
    "",
    ...(roleFamilies.length
      ? roleFamilies.map(
          (role) =>
            `- **${role.canonicalTitle}** (${role.roleClass}, confidence ${role.confidence.toFixed(2)}): ${role.problemPhrases.join(", ") || "No problem phrases recorded"}`,
        )
      : ["- No evidence-backed role families were generated."]),
    "",
    "## Deep source routes",
    "",
    ...workspace.sources.map(
      (source) =>
        `- [${source.name}](./${sourcePaths.get(source.id)}) - ${source.kind}${source.url ? `, ${source.url}` : ""}`,
    ),
    "",
    "## Important unknowns",
    "",
    ...(unknowns.length
      ? unknowns.map(
          (unknown) =>
            `- **${unknown.field}** (${unknown.materiality}): ${unknown.reason}`,
        )
      : ["- No material unknowns were recorded."]),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function renderCapabilityPage(
  topic: KnowledgeTopic,
  sourcePaths: Map<string, string>,
  sources: CandidateSource[],
) {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const evidenceLines = representativeClaims(topic.claims, 6).flatMap((claim) => [
    `### ${claim.capability}`,
    "",
    `**Canonical claim:** \`${claim.claimId}\``,
    "",
    claim.action,
    "",
    `- Support: ${claim.supportStatus}; confidence ${claim.confidence.toFixed(2)}`,
    `- Ownership / maturity / scope: ${claim.ownership} / ${claim.maturity} / ${claim.scope}`,
    `- Contexts: ${claim.workContexts.join(", ") || "Not specified"}`,
    `- Tools and methods: ${claim.toolsMethods.join(", ") || "Not specified"}`,
    ...(claim.outcomes.length
      ? [
          `- Outcomes: ${claim.outcomes
            .map((outcome) =>
              [outcome.description, outcome.metric, outcome.value]
                .filter(Boolean)
                .join(" - "),
            )
            .join("; ")}`,
        ]
      : []),
    ...(claim.limitations.length
      ? [`- Limitations: ${claim.limitations.join("; ")}`]
      : []),
    "",
    ...claim.sourceRefs.map((ref) => {
      const source = sourceById.get(ref.sourceId);
      const sourcePath = sourcePaths.get(ref.sourceId);
      const link = sourcePath
        ? `[${source?.name || ref.sourceId}](../${sourcePath})`
        : source?.name || ref.sourceId;
      return `> ${ref.quote}\n>\n> Source: ${link}; ${ref.locator}`;
    }),
    "",
  ]);
  const aliases = unique([topic.name, ...topic.aliases]);
  return `${[
    `# ${topic.name}`,
    "",
    capabilitySummary(topic),
    "",
    `**Aliases and retrieval terms:** ${aliases.join(", ")}`,
    "",
    "## What the evidence shows",
    "",
    ...evidenceLines,
    "## Reading boundary",
    "",
    "This page is a routing and synthesis layer. Use the linked source pages for deeper reader analysis and the canonical claim IDs above for final attribution.",
    "",
  ].join("\n")}\n`;
}

function renderSourcePage(input: {
  source: CandidateSource;
  snapshot?: SourceSnapshot;
  sourceClaims: EvidenceClaim[];
  knowledgeMarkdown?: string;
  insights: CandidateAnalysisResult["sourceInsights"][number]["insights"];
  unknowns: CandidateUnknown[];
  prohibitedInferences: ProhibitedInference[];
}) {
  const {
    source,
    snapshot,
    sourceClaims,
    knowledgeMarkdown,
    insights,
    unknowns,
    prohibitedInferences,
  } = input;
  const lines = [
    `# ${source.name}`,
    "",
    "## Source metadata",
    "",
    `- Source ID: \`${source.id}\``,
    snapshot ? `- Source version: \`${snapshot.sourceVersionId}\`` : "",
    `- Kind: ${source.kind}`,
    source.url ? `- URL: ${source.url}` : "",
    snapshot ? `- Retrieved: ${snapshot.retrievedAt}` : "",
    "",
    "## Source overview",
    "",
    ...(insights.length
      ? insights.flatMap((insight) => [
          `### ${insight.title}`,
          "",
          insight.summary,
          "",
          `- Category: ${insight.category}`,
          `- Skills: ${insight.skills.join(", ") || "Not specified"}`,
          `- Reader evidence: ${insight.evidence}`,
          "",
        ])
      : ["No concise source insights were extracted.", ""]),
    "## Deep reader analysis",
    "",
    "The narrative below is a source-owned retrieval aid. Canonical claims and exact quotations remain authoritative.",
    "",
    knowledgeMarkdown?.trim() ||
      "No detailed reader analysis was produced for this source.",
    "",
    "## Canonical evidence",
    "",
    sourceClaims.length
      ? `- ${sourceClaims.length} canonical claims link to this source; ${sourceClaims.filter((claim) => claim.supportStatus === "supported").length} are exactly supported.`
      : "- No canonical claims were accepted from this source.",
    "- Use the topic pages for representative quotations and `../../claims.jsonl` for the complete canonical ledger.",
    "",
    "## Unknowns and inference limits",
    "",
    ...(unknowns.length
      ? unknowns.map(
          (unknown) =>
            `- Unknown: **${unknown.field}** (${unknown.materiality}) - ${unknown.reason}`,
        )
      : []),
    ...(prohibitedInferences.length
      ? prohibitedInferences.map(
          (item) => `- Do not infer: ${item.rule} Reason: ${item.reason}`,
        )
      : []),
    ...(!unknowns.length && !prohibitedInferences.length
      ? ["- No source-specific unknowns or prohibited inferences were recorded."]
      : []),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function capabilitySummary(topic: KnowledgeTopic) {
  const supported = topic.claims.filter(
    (claim) => claim.supportStatus === "supported",
  ).length;
  const sources = new Set(
    topic.claims.flatMap((claim) =>
      claim.sourceRefs.map((ref) => ref.sourceVersionId),
    ),
  ).size;
  const strongest = [...topic.claims].sort(
    (left, right) => right.confidence - left.confidence,
  )[0];
  return `${topic.claims.length} canonical claim${topic.claims.length === 1 ? "" : "s"} (${supported} exactly supported) across ${sources} source version${sources === 1 ? "" : "s"}. ${strongest?.action || ""}`.trim();
}

function sourceSummary(source: CandidateSource, claims: EvidenceClaim[]) {
  const supported = claims.filter(
    (claim) => claim.supportStatus === "supported",
  ).length;
  return `${source.kind} source with ${claims.length} canonical claim${claims.length === 1 ? "" : "s"}, ${supported} exactly supported.`;
}

function claimKeywords(claim: EvidenceClaim) {
  return [
    claim.capability,
    claim.action,
    ...claim.workContexts,
    ...claim.toolsMethods,
    ...claim.credentials,
    ...claim.outcomes.flatMap((outcome) => [
      outcome.description,
      outcome.metric,
      outcome.value,
    ]),
  ];
}

function pageKeywords(values: string[]) {
  return unique(
    values.flatMap((value) => {
      const cleanValue = clean(value);
      if (!cleanValue) return [];
      const tokens = cleanValue
        .split(/[^A-Za-z0-9+#.]+/)
        .filter((token) => token.length >= 2);
      return [cleanValue, ...tokens];
    }),
  ).slice(0, 40);
}

function evidenceScore(claims: EvidenceClaim[]) {
  return claims.reduce(
    (total, claim) =>
      total +
      claim.confidence +
      (claim.supportStatus === "supported" ? 1 : 0) +
      Math.min(1, claim.sourceRefs.length / 2),
    0,
  );
}

function representativeClaims(claims: EvidenceClaim[], limit: number) {
  return [...claims]
    .sort(
      (left, right) =>
        Number(right.supportStatus === "supported") -
          Number(left.supportStatus === "supported") ||
        right.confidence - left.confidence ||
        right.sourceRefs.length - left.sourceRefs.length,
    )
    .slice(0, limit);
}

function isKnowledgeTopic(value: string) {
  const term = clean(value);
  return term.length >= 2 && term.length <= 100 && !/[{}=]/.test(term);
}

function topicAliases(value: string) {
  return unique(
    value
    .split(/\s*[/|,]\s*/)
    .map(clean)
      .filter((item) => item.length >= 2),
  );
}

function slug(value: string) {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\+/g, "-plus")
      .replace(/#/g, "-sharp")
      .replace(/\./g, "-dot-")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "evidence"
  );
}

function normalize(value: string) {
  return clean(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function unique(values: string[]) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function uniqueObjects<T>(values: T[], key: (value: T) => string) {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}
