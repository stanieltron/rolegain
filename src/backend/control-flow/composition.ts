import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexCandidateAnalyzer } from "../../01-evidence-ingestion/evidence-ingestion.js";
import { LiveOpportunityResearcher } from "../../03-match/opportunity-researcher.js";
import { CodexCoverLetterWriter } from "../../04-application-preparation/application-preparation.js";
import { CodexExecClient } from "../../codex-runtime/client.js";
import { JobSearchService } from "./service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(here, "..", "..", "..");

export interface RolegainDependencies {
  root: string;
  dataRoot: string;
  codex: CodexExecClient;
  jobSearch: JobSearchService;
  researcher: LiveOpportunityResearcher;
  writer: CodexCoverLetterWriter;
  close: () => Promise<void>;
}

/** Composition root used by HTTP, standalone stages, and live acceptance runners. */
export async function createRolegainDependencies(
  options: { rootDir?: string; dataRoot?: string } = {},
): Promise<RolegainDependencies> {
  const root = options.rootDir ?? defaultProjectRoot;
  const dataRoot = options.dataRoot ?? path.join(root, "data");
  const codex = new CodexExecClient(root);
  const researcher = new LiveOpportunityResearcher(codex, root, dataRoot);
  const writer = new CodexCoverLetterWriter(codex, root, dataRoot);
  const jobSearch = new JobSearchService(
    dataRoot,
    new CodexCandidateAnalyzer(codex, root),
    researcher,
    writer,
  );
  await jobSearch.initialize();
  return {
    root,
    dataRoot,
    codex,
    jobSearch,
    researcher,
    writer,
    close: async () => {
      await researcher.cancelAll();
      await codex.close();
    },
  };
}
