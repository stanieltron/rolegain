import path from "node:path";
import type {
  ApplicationDraft,
  FormField,
  JobSearchWorkspace,
} from "../contracts/job-search.js";
import { CodexExecClient } from "../codex-runtime/client.js";
import { productionModel } from "../codex-runtime/call-manifest.js";
import { mapParallelOrdered } from "../search-match-shared/parallel.js";
import { researchApplicationCompany } from "./00-company-research/index.js";
import { command as companyResearchCommand } from "./00-company-research/llm-calls/01-company-research/index.js";
import {
  buildApplicationContext,
  requireApplication,
} from "./01-context/index.js";
import { draftApplicationContent } from "./02-draft/index.js";
import { verifyApplicationDrafts } from "./03-verification/index.js";
import { repairApplicationDrafts } from "./04-repair/index.js";
import {
  refineApplicationAnswer,
  refineCoverLetter,
} from "./05-refinement/index.js";
import { tailorApplicationCv } from "./06-cv-tailoring/index.js";
import { command as cvTailoringCommand } from "./06-cv-tailoring/llm-calls/01-cv-tailoring/index.js";
import type {
  ApplicationAnswerRefinement,
  CoverLetterRefinement,
  CoverLetterWriter,
} from "./types.js";

/**
 * Top-level application-preparation facade.
 *
 * Automatic preparation composes Stage 01 through Stage 04. Stage 05 is an
 * explicit post-preparation user branch and is therefore exposed separately.
 */
export class CodexCoverLetterWriter implements CoverLetterWriter {
  constructor(
    private readonly codex: CodexExecClient,
    private readonly cwd: string,
    private readonly dataRoot = path.join(cwd, "data"),
  ) {}

  async draft(workspace: JobSearchWorkspace, applicationIds: string[]) {
    await this.ensureCompanyResearch(workspace, applicationIds);
    const contexts = await Promise.all(
      applicationIds.map((id) =>
        buildApplicationContext(
          workspace,
          requireApplication(workspace, id),
          this.dataRoot,
        ),
      ),
    );
    if (contexts.length === 0) return [];
    const model = await this.model();
    let drafts = await draftApplicationContent({
      codex: this.codex,
      cwd: this.cwd,
      model,
      contexts,
    });
    const first = await verifyApplicationDrafts({
      codex: this.codex,
      cwd: this.cwd,
      model,
      contexts,
      drafts,
    });
    const failures = first.filter((item) => item.verdict === "needs_repair");
    if (failures.length === 0) return drafts;

    drafts = await repairApplicationDrafts({
      codex: this.codex,
      cwd: this.cwd,
      model,
      contexts,
      drafts,
      failures,
    });
    const failedIds = new Set(failures.map((item) => item.applicationId));
    const final = await verifyApplicationDrafts({
      codex: this.codex,
      cwd: this.cwd,
      model,
      contexts: contexts.filter((item) => failedIds.has(item.applicationId)),
      drafts: drafts.filter((item) => failedIds.has(item.applicationId)),
    });
    const rejected = final.filter((item) => item.verdict === "needs_repair");
    if (rejected.length)
      throw new Error(
        `Independent application verification rejected ${rejected
          .map((item) => item.applicationId)
          .join(", ")} after one bounded repair`,
      );
    return drafts;
  }

  async refine(
    workspace: JobSearchWorkspace,
    application: ApplicationDraft,
    message: string,
  ): Promise<CoverLetterRefinement> {
    return refineCoverLetter({
      codex: this.codex,
      cwd: this.cwd,
      dataRoot: this.dataRoot,
      model: await this.model(),
      workspace,
      application,
      message,
    });
  }

  async refineAnswer(
    workspace: JobSearchWorkspace,
    application: ApplicationDraft,
    field: FormField,
    message: string,
  ): Promise<ApplicationAnswerRefinement> {
    return refineApplicationAnswer({
      codex: this.codex,
      cwd: this.cwd,
      dataRoot: this.dataRoot,
      model: await this.model(),
      workspace,
      application,
      field,
      message,
    });
  }

  async tailorCv(
    workspace: JobSearchWorkspace,
    application: ApplicationDraft,
  ) {
    if (!workspace.finalCv.trim())
      throw new Error("Upload a readable CV before generating a tailored version");
    await this.ensureCompanyResearch(workspace, [application.id]);
    return tailorApplicationCv({
      codex: this.codex,
      cwd: this.cwd,
      model: await this.modelFor(cvTailoringCommand),
      originalCv: workspace.finalCv,
      context: await buildApplicationContext(
        workspace,
        application,
        this.dataRoot,
      ),
    });
  }

  private async ensureCompanyResearch(
    workspace: JobSearchWorkspace,
    applicationIds: string[],
  ) {
    const applications = applicationIds
      .map((id) => requireApplication(workspace, id))
      .filter((application) => application.companyResearch?.status !== "ready");
    if (!applications.length) return;
    const model = await this.modelFor(companyResearchCommand);
    const concurrency = Math.max(
      1,
      Math.min(
        4,
        Number.parseInt(
          process.env.ROLEGAIN_COMPANY_RESEARCH_CONCURRENCY || "2",
          10,
        ) || 2,
      ),
    );
    await mapParallelOrdered(applications, concurrency, async (application) => {
      const job = workspace.opportunities.find(
        (candidate) => candidate.id === application.jobId,
      );
      if (!job) throw new Error("Unknown job opportunity");
      try {
        const research = await researchApplicationCompany({
          codex: this.codex,
          cwd: this.cwd,
          model,
          job,
        });
        application.companyResearch = {
          ...research,
          status: "ready",
          researchedAt: new Date().toISOString(),
        };
      } catch (error) {
        application.companyResearch = {
          status: "failed",
          company: job.company,
          overview: "",
          productsAndServices: [],
          customersAndMarkets: [],
          businessModel: "",
          cultureAndValues: [],
          recentSignals: [],
          tailoringAngles: [],
          sources: [],
          researchedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  private async modelFor(command: {
    modelEnvironment: string;
    defaultModel: string;
  }) {
    const runtime = await this.codex.start();
    if (!runtime.authenticated) throw new Error("Codex is not authenticated");
    return productionModel(command, runtime.model);
  }

  private model() {
    return this.modelFor({
      modelEnvironment: "ROLEGAIN_COVER_MODEL",
      defaultModel: "runtime default",
    });
  }
}
