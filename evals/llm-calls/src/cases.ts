import type { AgentCallManifest } from "../../../src/codex-runtime/call-manifest.js";
import { llmCallCatalog } from "../../../src/backend/control-flow/llm-call-catalog.js";
import { outputSchema as chunkAnalysisSchema } from "../../../src/01-evidence-ingestion/v1/02-chunk-reader/llm-calls/01-chunk-analysis/index.js";
import { outputSchema as chunkCoverageSchema } from "../../../src/01-evidence-ingestion/v1/02-chunk-reader/llm-calls/02-coverage-verification/index.js";
import { outputSchema as chunkRepairSchema } from "../../../src/01-evidence-ingestion/v1/02-chunk-reader/llm-calls/03-chunk-repair/index.js";
import { outputSchema as evidenceSynthesisSchema } from "../../../src/01-evidence-ingestion/03-synthesis/llm-calls/01-evidence-synthesis/index.js";
import { outputSchema as webDiscoverySchema } from "../../../src/02-search/v1/01-discovery/llm-calls/01-web-search/index.js";
import { outputSchema as sourceNavigationSchema } from "../../../src/02-search/v1/02-vacancy-source-expansion/browser-agent/llm-calls/01-source-navigation/index.js";
import { outputSchema as listingExtractionSchema } from "../../../src/02-search/v1/03-vacancy-validation/llm-calls/01-listing-extraction/index.js";
import { outputSchema as vacancyVerificationSchema } from "../../../src/02-search/v1/03-vacancy-validation/llm-calls/02-vacancy-verification/index.js";
import { outputSchema as requirementMatchingSchema } from "../../../src/03-match/shared/01-requirement-matching/llm-calls/01-requirement-matching/index.js";
import { outputSchema as tier2MatchingSchema } from "../../../src/03-match/shared/01-requirement-matching/llm-calls/02-tier2-matching/index.js";
import { outputSchema as matchVerificationSchema } from "../../../src/03-match/shared/01-requirement-matching/llm-calls/03-match-verification/index.js";
import { outputSchema as matchRepairSchema } from "../../../src/03-match/shared/01-requirement-matching/llm-calls/04-match-repair/index.js";
import { outputSchema as applicationNavigationSchema } from "../../../src/03-match/02-application-inspection/llm-calls/01-application-navigation/index.js";
import { outputSchema as applicationFieldMapSchema } from "../../../src/03-match/02-application-inspection/llm-calls/02-application-field-mapping/index.js";
import { outputSchema as applicationSchemaVerifySchema } from "../../../src/03-match/02-application-inspection/llm-calls/03-application-schema-verification/index.js";
import { outputSchema as companyResearchSchema } from "../../../src/04-application-preparation/00-company-research/llm-calls/01-company-research/index.js";
import { outputSchema as applicationDraftSchema } from "../../../src/04-application-preparation/02-draft/llm-calls/01-draft/index.js";
import { outputSchema as applicationVerifySchema } from "../../../src/04-application-preparation/03-verification/llm-calls/01-verification/index.js";
import { outputSchema as applicationRepairSchema } from "../../../src/04-application-preparation/04-repair/llm-calls/01-repair/index.js";
import { outputSchema as coverLetterRefineSchema } from "../../../src/04-application-preparation/05-refinement/llm-calls/01-cover-letter-refinement/index.js";
import { outputSchema as answerRefineSchema } from "../../../src/04-application-preparation/05-refinement/llm-calls/02-answer-refinement/index.js";
import { outputSchema as cvTailoringSchema } from "../../../src/04-application-preparation/06-cv-tailoring/llm-calls/01-cv-tailoring/index.js";

export type LlmEvalSuite =
  | "evidence.components"
  | "search.components"
  | "match.components"
  | "application-inspection.components"
  | "application-preparation.components";

export interface LlmEvalCase {
  id: string;
  suite: LlmEvalSuite;
  prompt: string;
  expected: unknown;
  schema: unknown;
  semanticChecks: string[];
  live: "default" | "opt-in";
}

const manifestById = new Map<string, AgentCallManifest>(
  llmCallCatalog.map((manifest) => [manifest.id, manifest]),
);

export function manifestForCase(testCase: LlmEvalCase) {
  const manifest = manifestById.get(testCase.id);
  if (!manifest) throw new Error(`No manifest for eval case ${testCase.id}`);
  return manifest;
}

const sourceChunkNotes = {
  profileFacts: {
    name: "Alex Rivera",
    email: "alex@example.com",
    phone: "",
    linkedin: "",
    github: "",
    website: "",
    location: "Berlin, Germany",
    headline: "Platform Engineer",
    summary: "Builds reliable TypeScript services and deployment automation.",
    skills: ["TypeScript", "Node.js", "PostgreSQL", "Docker"],
    languages: ["English"],
  },
  profileEvidence: [
    {
      field: "location",
      value: "Berlin, Germany",
      sourceId: "cv",
      locator: "p1",
      quote: "Berlin, Germany",
    },
  ],
  insights: [
    {
      id: "insight-platform",
      title: "Deployment reliability",
      summary: "Reduced failed deployments with validation and rollback controls.",
      evidence: "Reduced failed deployments by 35% through automated validation.",
      skills: ["TypeScript", "Docker"],
      category: "achievement",
    },
  ],
  detailedNotes: "Alex operated TypeScript services and deployment automation.",
  claims: [
    {
      action: "Reduced failed deployments",
      capability: "deployment reliability",
      workContexts: ["platform engineering"],
      toolsMethods: ["TypeScript", "Docker"],
      credentials: [],
      ownership: "primary",
      maturity: "operated",
      scope: "service",
      startDate: "2021",
      endDate: "present",
      outcomes: [{ description: "deployment failures reduced", metric: "failure reduction", value: "35%" }],
      sourceEvidence: [{ sourceId: "cv", locator: "p2", quote: "Reduced failed deployments by 35%" }],
      supportStatus: "supported",
      confidence: 0.9,
      limitations: [],
    },
  ],
  unknowns: [{ field: "work authorization", reason: "Not stated", materiality: "feasibility", sourceIds: ["cv"] }],
  prohibitedInferences: [{ rule: "Do not infer Kubernetes", reason: "Only Docker is stated", sourceIds: ["cv"] }],
};

const requirementAssessment = {
  jobId: "job-platform",
  requirements: [
    {
      kind: "required",
      category: "mandatory",
      requirement: "Experience operating TypeScript services",
      status: "matched",
      matchClass: "explicit",
      confidence: 0.9,
      gapClass: "none",
      gapSeverity: "none",
      normalizedCapability: "service operations",
      minimumDuration: 0,
      requiredOwnership: "",
      requiredMaturity: "operated",
      requiredScope: "service",
      requiredWorkContext: "platform engineering",
      requiredToolMethod: "TypeScript",
      requiredCredential: "",
      ambiguityFlags: [],
      sourceLocator: "requirements",
      explanation: "The candidate explicitly operated TypeScript services. The evidence is at service scope and includes deployment reliability work.",
      evidence: [
        {
          claimId: "claim-platform",
          sourceId: "cv",
          sourceVersionId: "v1",
          locator: "p2",
          excerpt: "Operated TypeScript services used by distributed engineering teams.",
        },
      ],
    },
  ],
};

export const LLM_EVAL_CASES: LlmEvalCase[] = [
  {
    id: "evidence.chunk-analysis",
    suite: "evidence.components",
    prompt: "Extract supported candidate facts and atomic claims from a CV chunk for Alex Rivera.",
    expected: sourceChunkNotes,
    schema: chunkAnalysisSchema,
    semanticChecks: ["has supported claims", "has exact source evidence", "records material unknowns"],
    live: "opt-in",
  },
  {
    id: "evidence.chunk-coverage",
    suite: "evidence.components",
    prompt: "Verify whether the extracted notes cover the supplied CV chunk.",
    expected: {
      complete: true,
      missingEvidence: [],
      unsupportedExtractions: [],
      summary: "The extraction covers the material platform engineering evidence.",
    },
    schema: chunkCoverageSchema,
    semanticChecks: ["returns explicit completeness verdict", "no missing findings on clean fixture"],
    live: "opt-in",
  },
  {
    id: "evidence.chunk-repair",
    suite: "evidence.components",
    prompt: "Repair one missing deployment reliability finding while preserving valid extracted notes.",
    expected: {
      additions: sourceChunkNotes,
      removals: [],
      resolutions: [{ findingId: "finding-1", status: "applied", reason: "Added the supported deployment reliability claim." }],
    },
    schema: chunkRepairSchema,
    semanticChecks: ["resolves every finding", "uses typed additions"],
    live: "opt-in",
  },
  {
    id: "evidence.synthesis",
    suite: "evidence.components",
    prompt: "Synthesize verified chunk notes into a candidate profile and search vocabulary.",
    expected: {
      profile: {
        name: "Alex Rivera",
        email: "alex@example.com",
        phone: "",
        linkedin: "",
        github: "",
        website: "",
        location: "Berlin, Germany",
        headline: "Platform Engineer",
        summary: "Builds reliable TypeScript services and deployment automation.",
        salaryExpectation: "",
        targetLocations: "Remote",
        workplace: "Remote",
        employmentTypes: "Full-time",
        workAuthorization: "",
        startDate: "",
        skills: ["TypeScript", "Node.js", "PostgreSQL", "Docker"],
        languages: ["English"],
      },
      profileEvidence: sourceChunkNotes.profileEvidence,
      unknowns: sourceChunkNotes.unknowns,
      contradictions: [],
      prohibitedInferences: sourceChunkNotes.prohibitedInferences,
      roleFamilies: [
        {
          canonicalTitle: "Platform Engineer",
          titleAliases: ["Platform Engineer", "Backend Platform Engineer"],
          problemPhrases: ["deployment reliability"],
          leadingCapabilities: ["service operations"],
          roleClass: "direct",
          geographyLanguageVariants: [{ geography: "Remote", language: "English", titles: ["Remote Platform Engineer"] }],
          confidence: 0.9,
        },
      ],
      searchVocabulary: {
        titleAliases: ["Platform Engineer"],
        evidenceIntersections: ["TypeScript deployment reliability"],
        problemPhrases: ["deployment reliability"],
        toolsMethodsStandards: ["TypeScript", "Docker"],
        adjacentDialects: ["Backend Engineer"],
        seniorityOwnershipModifiers: ["primary owner"],
        geographyLanguageVariants: ["Remote English"],
        negativeTerms: ["internship"],
      },
    },
    schema: evidenceSynthesisSchema,
    semanticChecks: ["preserves profile facts", "contains direct role family", "records prohibited inferences"],
    live: "opt-in",
  },
  {
    id: "search.web-discovery",
    suite: "search.components",
    prompt: "Return concrete public vacancy leads for a remote TypeScript platform engineer.",
    expected: {
      jobs: [
        {
          company: "Example Cloud",
          title: "Platform Engineer",
          location: "Remote",
          workplaceType: "Remote",
          employmentType: "Full-time",
          sourceKind: "vacancy",
          jobUrl: "https://example.com/jobs/platform-engineer",
          applyUrl: "https://example.com/jobs/platform-engineer/apply",
          description: "Platform role focused on TypeScript services.",
          compensation: "",
          discoveryQuery: "remote TypeScript platform engineer",
          sourceClass: "employer_career",
        },
      ],
    },
    schema: webDiscoverySchema,
    semanticChecks: ["returns public vacancy URL", "preserves discovery query", "classifies source"],
    live: "opt-in",
  },
  {
    id: "search.source-navigation",
    suite: "search.components",
    prompt: "Choose the next safe action for a vacancy source page with a visible Load more jobs button.",
    expected: { action: "click", controlId: "load-more", completion: "continue", reason: "The control explicitly loads more job listings." },
    schema: sourceNavigationSchema,
    semanticChecks: ["uses an observed control id", "does not invent navigation outside allowed actions"],
    live: "opt-in",
  },
  {
    id: "search.listing-extraction",
    suite: "search.components",
    prompt: "Extract one concrete vacancy from a captured listing page.",
    expected: {
      jobs: [
        {
          title: "Platform Engineer",
          company: "Example Cloud",
          location: "Remote",
          workplaceType: "Remote",
          employmentType: "Full-time",
          description: "Build and operate TypeScript platform services.",
          compensation: "",
          jobUrl: "https://example.com/jobs/platform-engineer",
          applyUrl: "https://example.com/jobs/platform-engineer/apply",
          openStatus: "open",
          publishedAt: "",
          validThrough: "",
          evidence: [{ field: "title", sourceText: "Platform Engineer" }],
        },
      ],
    },
    schema: listingExtractionSchema,
    semanticChecks: ["extracts concrete vacancy", "keeps evidence excerpts"],
    live: "opt-in",
  },
  {
    id: "search.vacancy-verification",
    suite: "search.components",
    prompt: "Verify a frozen job page for a currently open Platform Engineer vacancy.",
    expected: {
      pageType: "vacancy",
      openStatus: "open",
      title: "Platform Engineer",
      company: "Example Cloud",
      location: "Remote",
      workplaceType: "Remote",
      employmentType: "Full-time",
      description: "Build and operate TypeScript platform services.",
      compensation: "",
      applyUrl: "https://example.com/jobs/platform-engineer/apply",
      publishedAt: "",
      validThrough: "",
      confidence: 95,
      ambiguities: [],
      evidence: [{ field: "openStatus", sourceText: "Apply now" }],
    },
    schema: vacancyVerificationSchema,
    semanticChecks: ["classifies page as vacancy", "returns confidence and evidence"],
    live: "opt-in",
  },
  {
    id: "match.requirements",
    suite: "match.components",
    prompt:
      "Build a requirement matrix for a TypeScript platform engineering job using routed knowledge context and canonical citations.",
    expected: requirementAssessment,
    schema: requirementMatchingSchema,
    semanticChecks: [
      "has requirement rows",
      "uses knowledge pages only as retrieval context",
      "matched rows cite canonical claims",
    ],
    live: "opt-in",
  },
  {
    id: "match.tier2-evidence",
    suite: "match.components",
    prompt:
      "Reassess unresolved TypeScript service operations rows against bounded topic and source-page context.",
    expected: requirementAssessment,
    schema: tier2MatchingSchema,
    semanticChecks: [
      "preserves job id",
      "does not drop unresolved row",
      "cites canonical claims rather than knowledge prose",
    ],
    live: "opt-in",
  },
  {
    id: "match.verification",
    suite: "match.components",
    prompt: "Verify a supported requirement matrix.",
    expected: {
      jobId: "job-platform",
      verdict: "pass",
      findings: [],
      repairInstructions: [],
      inflationFlags: [],
      feasibilityFlags: [],
      statusConfidence: 0.95,
      decision: "accepted",
      rationale: "The assessment cites direct evidence for the stated requirement.",
    },
    schema: matchVerificationSchema,
    semanticChecks: ["returns pass or repair verdict", "includes rationale"],
    live: "opt-in",
  },
  {
    id: "match.repair",
    suite: "match.components",
    prompt: "Repair a rejected requirement matrix without changing unaffected jobs.",
    expected: requirementAssessment,
    schema: matchRepairSchema,
    semanticChecks: ["returns repaired assessment", "keeps citations"],
    live: "opt-in",
  },
  {
    id: "application.navigate",
    suite: "application-inspection.components",
    prompt: "Choose a safe action on an application page with an Apply button.",
    expected: { action: "click", controlId: "apply", reason: "The control is the explicit application entry point." },
    schema: applicationNavigationSchema,
    semanticChecks: ["uses allowed action", "uses observed control id"],
    live: "opt-in",
  },
  {
    id: "application.field-map",
    suite: "application-inspection.components",
    prompt: "Map name, email, CV, and cover letter fields to canonical keys.",
    expected: {
      fields: [
        { fieldId: "field-name", controlIds: ["field-name"], label: "Name", canonicalKey: "name", type: "text", required: true, options: [] },
        { fieldId: "field-email", controlIds: ["field-email"], label: "Email", canonicalKey: "email", type: "email", required: true, options: [] },
        { fieldId: "field-cv", controlIds: ["field-cv"], label: "Resume/CV", canonicalKey: "cv", type: "file", required: true, options: [] },
        { fieldId: "field-cover", controlIds: ["field-cover"], label: "Cover letter", canonicalKey: "cover_letter", type: "textarea", required: false, options: [] },
      ],
      ignoredControlIds: [],
    },
    schema: applicationFieldMapSchema,
    semanticChecks: ["maps every field id", "uses canonical keys only"],
    live: "opt-in",
  },
  {
    id: "application.schema-verify",
    suite: "application-inspection.components",
    prompt: "Verify a form schema with all required fields mapped.",
    expected: { issues: [] },
    schema: applicationSchemaVerifySchema,
    semanticChecks: ["returns explicit issue list"],
    live: "opt-in",
  },
  {
    id: "application.company-research",
    suite: "application-preparation.components",
    prompt:
      "Research Acme Cloud for one Platform Engineer application and return sourced company context.",
    expected: {
      company: "Acme Cloud",
      overview: "Acme Cloud provides deployment automation for engineering teams.",
      productsAndServices: ["Deployment orchestration platform"],
      customersAndMarkets: ["Software engineering organizations"],
      businessModel: "Subscription software",
      cultureAndValues: ["Operational reliability"],
      recentSignals: ["Expanded its deployment observability product"],
      tailoringAngles: ["Connect verified deployment reliability work to the product mission"],
      sources: [
        {
          title: "Acme Cloud product",
          url: "https://acme.example/product",
          evidence: "The official product page describes deployment orchestration.",
        },
      ],
    },
    schema: companyResearchSchema,
    semanticChecks: ["uses public sources", "returns role-specific tailoring angles"],
    live: "opt-in",
  },
  {
    id: "application.draft",
    suite: "application-preparation.components",
    prompt: "Draft one grounded answer and a concise cover letter for application app-1.",
    expected: {
      drafts: [
        {
          applicationId: "app-1",
          coverLetter: "I am interested in the Platform Engineer role because my TypeScript service operations experience matches the deployment reliability needs.",
          answers: [{ fieldId: "field-start", value: "Available after notice period", evidenceBasis: "Candidate start date is not confirmed, so the answer stays conservative." }],
        },
      ],
    },
    schema: applicationDraftSchema,
    semanticChecks: ["returns every application id", "answers include evidence basis"],
    live: "opt-in",
  },
  {
    id: "application.verify",
    suite: "application-preparation.components",
    prompt: "Verify one grounded application draft.",
    expected: {
      verifications: [{ applicationId: "app-1", verdict: "pass", findings: [], repairInstructions: [] }],
    },
    schema: applicationVerifySchema,
    semanticChecks: ["returns verdict per application", "repair instructions are explicit"],
    live: "opt-in",
  },
  {
    id: "application.repair",
    suite: "application-preparation.components",
    prompt: "Repair one failed application draft.",
    expected: {
      drafts: [
        {
          applicationId: "app-1",
          coverLetter: "I can support the Platform Engineer role with TypeScript service operations and deployment reliability work.",
          answers: [{ fieldId: "field-start", value: "", evidenceBasis: "Start date is not supported by supplied evidence." }],
        },
      ],
    },
    schema: applicationRepairSchema,
    semanticChecks: ["returns replacement draft", "does not fabricate unsupported answers"],
    live: "opt-in",
  },
  {
    id: "application.cover-letter-refine",
    suite: "application-preparation.components",
    prompt: "Shorten a grounded cover letter while keeping deployment reliability evidence.",
    expected: {
      coverLetter: "I bring TypeScript service operations and deployment reliability experience to the Platform Engineer role.",
      assistantMessage: "Shortened the letter while preserving the verified deployment reliability evidence.",
    },
    schema: coverLetterRefineSchema,
    semanticChecks: ["returns full revised cover letter", "assistant message explains change"],
    live: "opt-in",
  },
  {
    id: "application.answer-refine",
    suite: "application-preparation.components",
    prompt: "Refine one employer answer using only supplied evidence.",
    expected: {
      value: "I have operated TypeScript services and improved deployment reliability.",
      evidenceBasis: "Based on the verified claim about operating TypeScript services and reducing failed deployments.",
    },
    schema: answerRefineSchema,
    semanticChecks: ["returns full answer", "keeps evidence basis"],
    live: "opt-in",
  },
  {
    id: "application.cv-tailor",
    suite: "application-preparation.components",
    prompt:
      "Tailor a complete existing CV to one Platform Engineer application without adding facts.",
    expected: {
      content:
        "# Alex Rivera\n\n## Summary\nPlatform engineer focused on reliable TypeScript services.\n\n## Experience\n- Reduced failed deployments by 35% through automated validation.\n- Operated TypeScript services used by engineering teams.",
      changeSummary: [
        "Moved deployment reliability evidence earlier",
        "Emphasized verified TypeScript service operations",
      ],
    },
    schema: cvTailoringSchema,
    semanticChecks: ["returns a complete CV", "does not add unsupported candidate facts"],
    live: "opt-in",
  },
];
