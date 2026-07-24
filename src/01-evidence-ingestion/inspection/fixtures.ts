import type { JobSearchWorkspace } from "../../contracts/job-search.js";
import type {
  CandidateAnalysisResult,
  ChunkReadingResult,
} from "../types.js";
import type { SourceChunkNotes } from "../02-chunk-reader/llm-calls/01-chunk-analysis/output.js";
import type { EvidenceSynthesisOutput } from "../03-synthesis/llm-calls/01-evidence-synthesis/output.js";
import type { ChunkCoverageVerification } from "../02-chunk-reader/llm-calls/02-coverage-verification/output.js";

export const MOCK_CV_TEXT = [
  "Mira Example",
  "mira@example.test",
  "Implemented durable workflow recovery for failed jobs.",
  "Designed idempotent checkpoints for a TypeScript platform.",
  "Reduced manual recovery time by 40 percent.",
].join("\n");

export function mockWorkspace(): JobSearchWorkspace {
  return {
    id: "candidate-inspection",
    candidateId: "candidate-inspection",
    phase: "intake",
    profile: {
      name: "",
      email: "",
      phone: "",
      linkedin: "",
      github: "",
      website: "",
      location: "",
      headline: "",
      summary: "",
      salaryExpectation: "",
      targetLocations: "",
      workplace: "Remote",
      employmentTypes: "Full-time",
      workAuthorization: "",
      startDate: "Immediately",
      skills: [],
      languages: [],
    },
    sources: [],
    questions: [],
    opportunities: [],
    applications: [],
    rejectedOpportunities: [],
    searchValidationIssues: [],
    searchReadyOpportunities: [],
    jobHistory: [],
    seenJobUrls: [],
    searchConfig: { discoveryTarget: 20, applicationTarget: 5 },
    sharedAnswers: {},
    discoveryNeedsRun: true,
    profileSetupStep: 1,
    profileCompleteness: 0,
    finalCv: "",
    intelligence: { status: "idle" },
    updatedAt: "2026-07-20T08:00:00.000Z",
  };
}

export function mockWorkspaceWithCv(): JobSearchWorkspace {
  const workspace = mockWorkspace();
  workspace.profile.name = "Mira Example";
  workspace.profile.email = "mira@example.test";
  workspace.finalCv = MOCK_CV_TEXT;
  workspace.intelligence = { status: "analyzing" };
  workspace.sources = [
    {
      id: "cv-inspection",
      kind: "cv",
      name: "mira-cv.txt",
      content: MOCK_CV_TEXT,
      originalFile: { name: "mira-cv.txt" },
      status: "processing",
      analysisRequired: true,
      insights: [],
      addedAt: "2026-07-20T08:00:00.000Z",
    },
  ];
  return workspace;
}

export function mockChunkNotes(
  sourceId = "cv-inspection",
  quote = "Implemented durable workflow recovery for failed jobs.",
  capability = "workflow orchestration",
): SourceChunkNotes {
  return {
    profileFacts: {
      name: "Mira Example",
      email: "mira@example.test",
      phone: "",
      linkedin: "",
      github: "",
      website: "",
      location: "Bratislava",
      headline: "Platform Engineer",
      summary: "Builds reliable workflow systems.",
      skills: ["TypeScript", "workflow orchestration"],
      languages: ["English"],
    },
    profileEvidence: [
      {
        field: "name",
        value: "Mira Example",
        sourceId,
        locator: "mock locator",
        quote: "Mira Example",
      },
      {
        field: "email",
        value: "mira@example.test",
        sourceId,
        locator: "mock locator",
        quote: "mira@example.test",
      },
      ...(["location", "headline", "summary", "skills", "languages"] as const).map(
        (field) => ({
          field,
          value:
            field === "location"
              ? "Bratislava"
              : field === "headline"
                ? "Platform Engineer"
                : field === "summary"
                  ? "Builds reliable workflow systems."
                  : field === "skills"
                    ? "TypeScript"
                    : "English",
          sourceId,
          locator: "mock locator",
          quote,
        }),
      ),
      {
        field: "skills",
        value: "workflow orchestration",
        sourceId,
        locator: "mock locator",
        quote,
      },
    ],
    insights: [
      {
        id: `insight-${capability.replace(/\W+/g, "-")}`,
        title: capability,
        summary: quote,
        evidence: quote,
        skills: ["TypeScript"],
        category: "project",
      },
    ],
    detailedNotes: `## ${capability}\n\n${quote}`,
    claims: [
      {
        action: quote.replace(/\.$/, "").toLowerCase(),
        capability,
        workContexts: ["production workflow platform"],
        toolsMethods: ["TypeScript", "idempotent checkpoints"],
        credentials: [],
        ownership: "lead",
        maturity: "operated",
        scope: "system",
        startDate: "",
        endDate: "",
        outcomes: [],
        sourceEvidence: [{ sourceId, locator: "mock locator", quote }],
        supportStatus: "supported",
        confidence: 0.92,
        limitations: [],
      },
    ],
    unknowns: [],
    prohibitedInferences: [],
  };
}

/** Reader output with three inspectable chunks, used as Stage 03 mock input. */
export function mockThreeChunkReading(
  workspace = mockWorkspaceWithCv(),
): ChunkReadingResult {
  const source = workspace.sources[0];
  const chunks = [
    mockChunkNotes(
      source.id,
      "Implemented durable workflow recovery for failed jobs.",
      "workflow orchestration",
    ),
    mockChunkNotes(
      source.id,
      "Designed idempotent checkpoints for a TypeScript platform.",
      "reliability engineering",
    ),
    mockChunkNotes(
      source.id,
      "Reduced manual recovery time by 40 percent.",
      "operational improvement",
    ),
  ];
  return {
    sourceNotes: [
      {
        sourceId: source.id,
        kind: source.kind,
        name: source.name,
        chunks,
      },
    ],
    sourceInsights: [
      {
        sourceId: source.id,
        insights: chunks.flatMap((chunk) => chunk.insights),
        knowledgeMarkdown: chunks
          .map((chunk) => chunk.detailedNotes)
          .join("\n\n---\n\n"),
        claims: chunks.flatMap((chunk) => chunk.claims),
        unknowns: [],
        prohibitedInferences: [],
      },
    ],
    totalChunks: 3,
  };
}

export function mockSynthesis(
  workspace = mockWorkspaceWithCv(),
): EvidenceSynthesisOutput {
  const profileEvidence = mockThreeChunkReading(workspace).sourceNotes.flatMap(
    (source) => source.chunks.flatMap((chunk) => chunk.profileEvidence),
  );
  return {
    profile: {
      ...workspace.profile,
      name: "Mira Example",
      email: "mira@example.test",
      location: "Bratislava",
      headline: "Platform Engineer",
      summary: "Builds reliable TypeScript workflow systems.",
      skills: ["TypeScript", "workflow orchestration"],
      languages: ["English"],
    },
    profileEvidence: profileEvidence.map((item) =>
      item.field === "summary"
        ? { ...item, value: "Builds reliable TypeScript workflow systems." }
        : item,
    ),
    unknowns: [],
    contradictions: [],
    prohibitedInferences: [],
    roleFamilies: [
      {
        canonicalTitle: "Platform Engineer",
        titleAliases: ["Backend Platform Engineer"],
        problemPhrases: ["workflow reliability"],
        leadingCapabilities: ["workflow orchestration"],
        roleClass: "direct",
        geographyLanguageVariants: [],
        confidence: 0.9,
      },
    ],
    searchVocabulary: {
      titleAliases: ["Platform Engineer", "Backend Platform Engineer"],
      evidenceIntersections: ["TypeScript workflow orchestration"],
      problemPhrases: ["workflow reliability"],
      toolsMethodsStandards: ["TypeScript", "idempotent checkpoints"],
      adjacentDialects: ["developer platform"],
      seniorityOwnershipModifiers: ["lead"],
      geographyLanguageVariants: ["Remote Europe"],
      negativeTerms: [],
    },
  };
}

export function mockCoverage(
  input: Partial<ChunkCoverageVerification> = {},
): ChunkCoverageVerification {
  return {
    complete: true,
    missingEvidence: [],
    unsupportedExtractions: [],
    summary: "All material candidate evidence is covered.",
    ...input,
  };
}

export function mockAnalysis(
  workspace = mockWorkspaceWithCv(),
  reading = mockThreeChunkReading(workspace),
): CandidateAnalysisResult {
  return {
    ...mockSynthesis(workspace),
    threadId: "mock-synthesis-thread",
    sourceInsights: reading.sourceInsights,
  };
}
