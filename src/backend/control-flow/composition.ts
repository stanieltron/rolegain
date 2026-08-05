import path from "node:path";
import { CodexCandidateAnalyzerV1 } from "../../01-evidence-ingestion/v1/index.js";
import { CodexCandidateAnalyzerV2 } from "../../01-evidence-ingestion/v2/index.js";
import { LiveOpportunityResearcher } from "../../03-match/opportunity-researcher.js";
import { CodexCoverLetterWriter } from "../../04-application-preparation/application-preparation.js";
import { CodexExecClient } from "../../codex-runtime/client.js";
import { createLlmClient } from "../../llm-runtime/client.js";
import { JobSearchService } from "./service.js";
import { runtimeConfiguration, type RuntimeConfiguration } from "../../config/runtime.js";
import {
  createDatabasePool,
  migrateDatabase,
  sessionPoolSize,
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
import { PlatformControl } from "../admin/platform-control.js";
import { appendDiagnosticEvent } from "../../diagnostics/run-log.js";
import { createWorkflowFailureNotifier } from "../notifications/workflow-error-email.js";

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
  sessionDatabase?: Pool;
  tokenCounter: TokenCounter;
  artifacts: ArtifactArchive;
  workflows?: WorkflowQueue;
  platform: PlatformControl;
  close: () => Promise<void>;
}

/** Composition root used by HTTP, standalone stages, and live acceptance runners. */
export async function createRolegainDependencies(
  options: { rootDir?: string; dataRoot?: string } = {},
): Promise<RolegainDependencies> {
  const root = options.rootDir ?? defaultProjectRoot;
  const dataRoot = options.dataRoot ?? path.join(root, "data");
  const configuration = runtimeConfiguration();
  const serviceName = configuration.processJobs ? "worker" : "web";
  const database = configuration.applicationDatabaseUrl
    ? createDatabasePool(configuration.applicationDatabaseUrl, {
        applicationName: `rolegain-${serviceName}-application`,
      })
    : undefined;
  const sessionDatabase = configuration.databaseUrl
    ? configuration.databaseUrl === configuration.applicationDatabaseUrl
      ? database
      : createDatabasePool(configuration.databaseUrl, {
          max: sessionPoolSize(),
          applicationName: `rolegain-${serviceName}-session`,
        })
    : undefined;
  if (sessionDatabase) await migrateDatabase(sessionDatabase);
  const workspaceStore = database
    ? new PostgresWorkspaceStore(database)
    : new FileWorkspaceStore(
        path.join(dataRoot, "job-search", "candidates"),
      );
  const tokenCounter = database
    ? new PostgresTokenCounter(database)
    : new MemoryTokenCounter();
  const platform = new PlatformControl(database);
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
  codex.beforeTurn = () => platform.assertCodexEnabled();
  const researcher = new LiveOpportunityResearcher(
    codex,
    root,
    dataRoot,
    configuration.searchVersion,
    configuration.matchVersion,
  );
  const writer = new CodexCoverLetterWriter(codex, root, dataRoot);
  const jobSearch = new JobSearchService(
    dataRoot,
    configuration.evidenceIngestionVersion === "v2"
      ? new CodexCandidateAnalyzerV2(codex, root)
      : new CodexCandidateAnalyzerV1(codex, root),
    researcher,
    writer,
    undefined,
    workspaceStore,
  );
  const defaultCandidateId =
    configuration.authMode === "local" ? "candidate-1" : false;
  if (defaultCandidateId)
    await codex.runWithExecutionContext({ userId: defaultCandidateId }, () =>
      jobSearch.initialize({ defaultCandidateId }),
    );
  else await jobSearch.initialize({ defaultCandidateId: false });
  codex.onRunCompleted = async (observation) => {
    if (observation.executionContext)
      await tokenCounter.record(observation.executionContext, observation);
    await appendDiagnosticEvent("llm-run-completed", {
      ...observation,
      finalText: observation.finalText,
    });
  };
  codex.onNotification = (message) =>
    appendDiagnosticEvent("codex-notification", { message });
  codex.onStderr = (line) => {
    void appendDiagnosticEvent("codex-stderr", { line });
  };
  const workflows =
    database && configuration.databaseUrl
      ? new PostgresWorkflowQueue(
          configuration.databaseUrl,
          database,
          sessionDatabase!,
          jobSearch,
          codex,
          artifacts,
          platform,
          configuration.processJobs,
          createWorkflowFailureNotifier({
            apiKey: configuration.resendApiKey,
            to: configuration.errorEmailTo,
            from: configuration.errorEmailFrom,
            adminUrl: configuration.publicOrigin
              ? `${configuration.publicOrigin.replace(/\/$/, "")}/admin`
              : undefined,
          }),
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
    sessionDatabase,
    tokenCounter,
    artifacts,
    workflows,
    platform,
    close: async () => {
      await workflows?.close();
      await researcher.cancelAll();
      await codex.close();
      await database?.end();
      if (sessionDatabase && sessionDatabase !== database)
        await sessionDatabase.end();
    },
  };
}
