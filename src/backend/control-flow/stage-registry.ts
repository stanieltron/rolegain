export type StageRunnerDefinition =
  | { kind: "evidence-inspection"; stage: "acquisition" | "search-handoff" }
  | {
      kind: "evidence-pipeline";
      stage:
        | "acquire"
        | "prepare-chunks"
        | "chunk-analysis"
        | "chunk-coverage"
        | "chunk-repair"
        | "apply-chunk-repair"
        | "accept-chunk"
        | "read-chunk"
        | "join-chunks"
        | "ingest";
    }
  | {
      kind: "live-stage";
      stage:
        | "evidence-reader"
        | "evidence-synthesis"
        | "evidence-verification"
        | "evidence"
        | "opportunity-research"
        | "discovery"
        | "matching"
        | "inspection"
        | "application-context"
        | "application-draft"
        | "application-verification"
        | "application-repair"
        | "application-refinement"
        | "drafting"
        | "full";
    }
  | { kind: "vacancy-validation" };

export interface RunnableStage {
  id: string;
  pipeline: "01-evidence-ingestion" | "02-search" | "03-match" | "04-application-preparation" | "full-flow";
  stage: string;
  title: string;
  purpose: string;
  inputKind: string;
  outputKind: string;
  runner: StageRunnerDefinition;
  reads: string[];
  writes: string[];
}

export const runnableStages = [
  {
    id: "evidence.acquire-source",
    pipeline: "01-evidence-ingestion",
    stage: "01-evidence-acquisition",
    title: "Acquire Evidence Source",
    purpose: "Read one CV or supplemental source and update candidate source state.",
    inputKind: "rolegain.evidence.acquire.input",
    outputKind: "rolegain.evidence.acquire.output",
    runner: { kind: "evidence-pipeline", stage: "acquire" },
    reads: ["source input", "candidate workspace"],
    writes: ["candidate source state"],
  },
  {
    id: "evidence.prepare-chunks",
    pipeline: "01-evidence-ingestion",
    stage: "02-chunk-reader.prepare",
    title: "Prepare Source Chunks",
    purpose: "Deterministically split pending source text into independently runnable chunk jobs.",
    inputKind: "rolegain.evidence.prepare-chunks.input",
    outputKind: "rolegain.evidence.prepare-chunks.output",
    runner: { kind: "evidence-pipeline", stage: "prepare-chunks" },
    reads: ["candidate workspace with source text"],
    writes: ["ordered prepared chunk jobs"],
  },
  {
    id: "evidence.analyze-chunk",
    pipeline: "01-evidence-ingestion",
    stage: "evidence.chunk-analysis",
    title: "Analyze One Chunk",
    purpose: "Run the raw evidence.chunk-analysis LLM call for exactly one prepared chunk.",
    inputKind: "rolegain.evidence.analyze-chunk.input",
    outputKind: "rolegain.evidence.analyze-chunk.output",
    runner: { kind: "evidence-pipeline", stage: "chunk-analysis" },
    reads: ["one prepared chunk job", "optional recovery feedback"],
    writes: ["normalized source chunk notes", "Codex run trace"],
  },
  {
    id: "evidence.verify-chunk-coverage",
    pipeline: "01-evidence-ingestion",
    stage: "evidence.chunk-coverage",
    title: "Verify One Chunk Extraction",
    purpose: "Run the raw independent coverage LLM call against one chunk and its extraction.",
    inputKind: "rolegain.evidence.verify-chunk-coverage.input",
    outputKind: "rolegain.evidence.verify-chunk-coverage.output",
    runner: { kind: "evidence-pipeline", stage: "chunk-coverage" },
    reads: ["one prepared chunk", "one normalized chunk analysis"],
    writes: ["coverage verification", "deterministic coverage decision", "Codex run trace"],
  },
  {
    id: "evidence.repair-chunk",
    pipeline: "01-evidence-ingestion",
    stage: "evidence.chunk-repair",
    title: "Repair One Chunk Extraction",
    purpose: "Emit a reasoned evidence delta for blocking coverage findings without regenerating valid content.",
    inputKind: "rolegain.evidence.repair-chunk.input",
    outputKind: "rolegain.evidence.repair-chunk.output",
    runner: { kind: "evidence-pipeline", stage: "chunk-repair" },
    reads: ["one chunk analysis", "one failed typed coverage decision", "source chunk"],
    writes: ["typed repair patch", "finding resolutions", "Codex run trace"],
  },
  {
    id: "evidence.apply-chunk-repair",
    pipeline: "01-evidence-ingestion",
    stage: "02-chunk-reader.apply-repair",
    title: "Apply One Chunk Repair",
    purpose: "Deterministically merge a repair delta while preserving unrelated extracted evidence.",
    inputKind: "rolegain.evidence.apply-chunk-repair.input",
    outputKind: "rolegain.evidence.apply-chunk-repair.output",
    runner: { kind: "evidence-pipeline", stage: "apply-chunk-repair" },
    reads: ["current chunk analysis", "typed repair patch", "source chunk"],
    writes: ["merged chunk analysis", "repair audit"],
  },
  {
    id: "evidence.accept-chunk",
    pipeline: "01-evidence-ingestion",
    stage: "02-chunk-reader.accept-one",
    title: "Accept Verified Chunk",
    purpose: "Fail closed unless raw chunk coverage passed, then promote its analysis to a verified chunk result.",
    inputKind: "rolegain.evidence.accept-chunk.input",
    outputKind: "rolegain.evidence.accept-chunk.output",
    runner: { kind: "evidence-pipeline", stage: "accept-chunk" },
    reads: ["one chunk analysis", "one passing coverage decision"],
    writes: ["one verified chunk result"],
  },
  {
    id: "evidence.read-chunk",
    pipeline: "01-evidence-ingestion",
    stage: "02-chunk-reader.read-one",
    title: "Read And Verify One Chunk",
    purpose: "Run one complete reader, coverage, and bounded targeted-retry transaction.",
    inputKind: "rolegain.evidence.read-chunk.input",
    outputKind: "rolegain.evidence.read-chunk.output",
    runner: { kind: "evidence-pipeline", stage: "read-chunk" },
    reads: ["one prepared chunk job"],
    writes: ["one verified chunk reading", "reader and coverage traces"],
  },
  {
    id: "evidence.read-chunks",
    pipeline: "01-evidence-ingestion",
    stage: "02-chunk-reader",
    title: "Read Source Chunks",
    purpose: "Run one isolated reader-and-coverage transaction per chunk in parallel and join ordered notes.",
    inputKind: "rolegain.evidence.read-chunks.input",
    outputKind: "rolegain.evidence.read-chunks.output",
    runner: { kind: "live-stage", stage: "evidence-reader" },
    reads: ["candidate workspace with source text"],
    writes: ["prepared jobs", "one-chunk results", "joined reading result", "Codex run traces"],
  },
  {
    id: "evidence.join-chunks",
    pipeline: "01-evidence-ingestion",
    stage: "02-chunk-reader.join",
    title: "Join Verified Chunk Readings",
    purpose: "Deterministically join ordered one-chunk results into the Stage 02 reading contract.",
    inputKind: "rolegain.evidence.join-chunks.input",
    outputKind: "rolegain.evidence.join-chunks.output",
    runner: { kind: "evidence-pipeline", stage: "join-chunks" },
    reads: ["prepared chunk jobs", "one verified result per chunk"],
    writes: ["ordered chunk reading result"],
  },
  {
    id: "evidence.synthesize",
    pipeline: "01-evidence-ingestion",
    stage: "03-synthesis",
    title: "Synthesize Evidence",
    purpose: "Reduce chunk notes into candidate-wide profile, role, and search facts.",
    inputKind: "rolegain.evidence.synthesize.input",
    outputKind: "rolegain.evidence.synthesize.output",
    runner: { kind: "live-stage", stage: "evidence-synthesis" },
    reads: ["candidate workspace", "chunk reading result"],
    writes: ["candidate analysis result", "Codex run trace"],
  },
  {
    id: "evidence.verify-ledger",
    pipeline: "01-evidence-ingestion",
    stage: "04-verification",
    title: "Verify Evidence Ledger",
    purpose: "Audit quotes exactly and persist the canonical evidence run.",
    inputKind: "rolegain.evidence.verify-ledger.input",
    outputKind: "rolegain.evidence.verify-ledger.output",
    runner: { kind: "live-stage", stage: "evidence-verification" },
    reads: ["candidate workspace", "candidate analysis result", "source text"],
    writes: ["canonical evidence run", "readiness manifest"],
  },
  {
    id: "evidence.ingest",
    pipeline: "01-evidence-ingestion",
    stage: "evidence-ingestion",
    title: "Ingest Evidence",
    purpose: "Acquire one or more CV, document, repository, or webpage sources, then read, synthesize, verify, and persist the canonical evidence run.",
    inputKind: "rolegain.evidence.ingest.input",
    outputKind: "rolegain.evidence.ingest.output",
    runner: { kind: "evidence-pipeline", stage: "ingest" },
    reads: ["one or more evidence source inputs", "candidate workspace"],
    writes: ["candidate workspace", "canonical evidence run", "readiness", "Codex run traces"],
  },
  {
    id: "search.run",
    pipeline: "02-search",
    stage: "search",
    title: "Run Search",
    purpose: "Discover public vacancies and validate that they are current, concrete, and compatible with hard constraints.",
    inputKind: "rolegain.search.run.input",
    outputKind: "rolegain.search.run.output",
    runner: { kind: "live-stage", stage: "discovery" },
    reads: ["search-ready workspace", "canonical evidence run"],
    writes: ["validated opportunities", "search failures", "Codex run traces"],
  },
  {
    id: "search.discovery",
    pipeline: "02-search",
    stage: "01-discovery",
    title: "Discover And Validate Jobs",
    purpose: "Search the public web and validate concrete live vacancies.",
    inputKind: "rolegain.search.discovery.input",
    outputKind: "rolegain.search.discovery.output",
    runner: { kind: "live-stage", stage: "discovery" },
    reads: ["search-ready workspace", "canonical evidence run"],
    writes: ["validated opportunities", "search failures", "Codex run traces"],
  },
  {
    id: "search.validate-vacancies",
    pipeline: "02-search",
    stage: "03-vacancy-validation",
    title: "Validate Vacancy URLs",
    purpose: "Re-open supplied job URLs and keep only current vacancies that satisfy hard constraints.",
    inputKind: "rolegain.search.validate-vacancies.input",
    outputKind: "rolegain.search.validate-vacancies.output",
    runner: { kind: "vacancy-validation" },
    reads: ["candidate workspace", "candidate job URLs"],
    writes: ["live validated opportunities", "validation failures", "Codex run traces"],
  },
  {
    id: "match.requirements",
    pipeline: "03-match",
    stage: "01-requirement-matching",
    title: "Match Requirements",
    purpose: "Map validated vacancy requirements to the canonical candidate evidence ledger.",
    inputKind: "rolegain.match.requirements.input",
    outputKind: "rolegain.match.requirements.output",
    runner: { kind: "live-stage", stage: "matching" },
    reads: ["validated opportunities", "canonical evidence run"],
    writes: ["matched opportunities", "requirement matrix", "Codex run traces"],
  },
  {
    id: "applications.inspect-form",
    pipeline: "03-match",
    stage: "02-application-inspection",
    title: "Inspect Application Form",
    purpose: "Open employer application pages and map observed fields.",
    inputKind: "rolegain.applications.inspect-form.input",
    outputKind: "rolegain.applications.inspect-form.output",
    runner: { kind: "live-stage", stage: "inspection" },
    reads: ["matched opportunities"],
    writes: ["mapped applications", "form inspection failures", "Codex run traces"],
  },
  {
    id: "applications.build-context",
    pipeline: "04-application-preparation",
    stage: "01-context",
    title: "Build Application Context",
    purpose: "Assemble the bounded candidate, job, source, and employer-form context for selected applications.",
    inputKind: "rolegain.applications.build-context.input",
    outputKind: "rolegain.applications.build-context.output",
    runner: { kind: "live-stage", stage: "application-context" },
    reads: ["mapped applications", "matched opportunities", "canonical evidence run"],
    writes: ["grounded application contexts"],
  },
  {
    id: "applications.draft",
    pipeline: "04-application-preparation",
    stage: "02-draft",
    title: "Draft Application Content",
    purpose: "Draft grounded application answers and cover letters from prepared contexts.",
    inputKind: "rolegain.applications.draft.input",
    outputKind: "rolegain.applications.draft.output",
    runner: { kind: "live-stage", stage: "application-draft" },
    reads: ["grounded application contexts"],
    writes: ["application content drafts", "Codex run traces"],
  },
  {
    id: "applications.verify",
    pipeline: "04-application-preparation",
    stage: "03-verification",
    title: "Verify Application Drafts",
    purpose: "Independently verify grounding and deterministic employer-form rules.",
    inputKind: "rolegain.applications.verify.input",
    outputKind: "rolegain.applications.verify.output",
    runner: { kind: "live-stage", stage: "application-verification" },
    reads: ["grounded application contexts", "application content drafts"],
    writes: ["draft verification results", "Codex run traces"],
  },
  {
    id: "applications.repair",
    pipeline: "04-application-preparation",
    stage: "04-repair",
    title: "Repair Application Drafts",
    purpose: "Repair only drafts rejected by independent verification.",
    inputKind: "rolegain.applications.repair.input",
    outputKind: "rolegain.applications.repair.output",
    runner: { kind: "live-stage", stage: "application-repair" },
    reads: ["grounded contexts", "drafts", "failed verification results"],
    writes: ["repaired application drafts", "Codex run traces"],
  },
  {
    id: "applications.refine",
    pipeline: "04-application-preparation",
    stage: "05-refinement",
    title: "Refine Application Content",
    purpose: "Apply one user-requested grounded revision to a cover letter or employer answer.",
    inputKind: "rolegain.applications.refine.input",
    outputKind: "rolegain.applications.refine.output",
    runner: { kind: "live-stage", stage: "application-refinement" },
    reads: ["workspace application", "refinement request", "canonical evidence"],
    writes: ["refined content", "Codex run trace"],
  },
  {
    id: "applications.prepare",
    pipeline: "04-application-preparation",
    stage: "complete-application-preparation",
    title: "Complete Application Preparation",
    purpose: "Build contexts, draft, verify, conditionally repair, and return filled applications.",
    inputKind: "rolegain.applications.prepare.input",
    outputKind: "rolegain.applications.prepare.output",
    runner: { kind: "live-stage", stage: "drafting" },
    reads: ["mapped applications", "matched opportunities", "canonical evidence run"],
    writes: ["filled applications", "draft verification results", "Codex run traces"],
  },
  {
    id: "full.acceptance-flow",
    pipeline: "full-flow",
    stage: "full",
    title: "Full Acceptance Flow",
    purpose: "Run the complete end-to-end live acceptance flow.",
    inputKind: "rolegain.full.input",
    outputKind: "rolegain.full.output",
    runner: { kind: "live-stage", stage: "full" },
    reads: ["source input"],
    writes: ["prepared applications", "validated jobs", "Codex run traces"],
  },
] as const satisfies readonly RunnableStage[];

export type RunnableStageId = (typeof runnableStages)[number]["id"];

export function runnableStageById(id: string): RunnableStage {
  const stage = runnableStages.find((candidate) => candidate.id === id);
  if (!stage)
    throw new Error(
      `Unknown runnable stage ${id}. Use one of: ${runnableStages
        .map((candidate) => candidate.id)
        .join(", ")}`,
    );
  return stage;
}
