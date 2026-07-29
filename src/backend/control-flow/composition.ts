import path from "node:path";
import { CodexCandidateAnalyzer } from "../../01-evidence-ingestion/evidence-ingestion.js";
import { LiveOpportunityResearcher } from "../../03-match/opportunity-researcher.js";
import { CodexCoverLetterWriter } from "../../04-application-preparation/application-preparation.js";
import { CodexExecClient } from "../../codex-runtime/client.js";
import { createLlmClient } from "../../llm-runtime/client.js";
import { JobSearchService } from "./service.js";
import { runtimeConfiguration, type RuntimeConfiguration } from "../../config/runtime.js";
import {
  createDatabasePool,
  migrateDatabase,
} from "../../infrastructure/database.js";
import {
  FileWorkspaceStore,
  PostgresWorkspaceStore,
} from "../persistence/workspace-store.js";
import {
  LocalArtifactArchive,
  SupabaseArtifactArchive,
  type ArtifactArchive,
} from "../persistence/artifact-archive.js";
import {
  MemoryTokenCounter,
  PostgresTokenCounter,
  type TokenCounter,
} from "../usage/token-counter.js";
import {
  PostgresWorkflowQueue,
  type WorkflowQueue,
} from "../workflows/workflow-queue.js";
import type { Pool } from "pg";

const defaultProjectRoot = process.cwd();

export interface RolegainDependencies {
  root: string;
  dataRoot: string;
  codex: CodexExecClient;
  jobSearch: JobSearchService;
  researcher: LiveOpportunityResearcher;
  writer: CodexCoverLetterWriter;
  configuration: RuntimeConfiguration;
  database?: Pool;
  tokenCounter: TokenCounter;
  artifacts: ArtifactArchive;
  workflows?: WorkflowQueue;
  close: () => Promise<void>;
}

/** Composition root used by HTTP, standalone stages, and live acceptance runners. */
export async function createRolegainDependencies(
  options: { rootDir?: string; dataRoot?: string } = {},
): Promise<RolegainDependencies> {
  const root = options.rootDir ?? defaultProjectRoot;
  const dataRoot = options.dataRoot ?? path.join(root, "data");
  const configuration = runtimeConfiguration();
  const database = configuration.databaseUrl
    ? createDatabasePool(configuration.databaseUrl)
    : undefined;
  if (database) await migrateDatabase(database);
  const workspaceStore = database
    ? new PostgresWorkspaceStore(database)
    : new FileWorkspaceStore(
        path.join(dataRoot, "job-search", "candidates"),
      );
  const tokenCounter = database
    ? new PostgresTokenCounter(database)
    : new MemoryTokenCounter();
  const artifacts =
    configuration.objectStorageEnabled
      ? new SupabaseArtifactArchive(
          dataRoot,
          configuration.supabaseUrl!,
          configuration.supabaseServiceRoleKey!,
          configuration.supabaseStorageBucket,
        )
      : new LocalArtifactArchive();
  await artifacts.initialize();
  const codex = createLlmClient(root);
  const researcher = new LiveOpportunityResearcher(codex, root, dataRoot);
  const writer = new CodexCoverLetterWriter(codex, root, dataRoot);
  const jobSearch = new JobSearchService(
    dataRoot,
    new CodexCandidateAnalyzer(codex, root),
    researcher,
    writer,
    undefined,
    workspaceStore,
  );
  await jobSearch.initialize({
    defaultCandidateId:
      configuration.authMode === "local" ? "candidate-1" : false,
  });
  codex.onRunCompleted = async (observation) => {
    if (observation.executionContext)
      await tokenCounter.record(observation.executionContext, observation);
  };
  const workflows =
    database && configuration.databaseUrl
      ? new PostgresWorkflowQueue(
          configuration.databaseUrl,
          database,
          jobSearch,
          codex,
          artifacts,
        )
      : undefined;
  if (workflows) await workflows.start(configuration.processJobs);
  return {
    root,
    dataRoot,
    codex,
    jobSearch,
    researcher,
    writer,
    configuration,
    database,
    tokenCounter,
    artifacts,
    workflows,
    close: async () => {
      await workflows?.close();
      await researcher.cancelAll();
      await codex.close();
      await database?.end();
    },
  };
}
