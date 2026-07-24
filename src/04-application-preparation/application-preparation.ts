import path from "node:path";
import type {
  ApplicationDraft,
  FormField,
  JobSearchWorkspace,
} from "../contracts/job-search.js";
import { CodexExecClient } from "../codex-runtime/client.js";
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

  private async model() {
    const runtime = await this.codex.start();
    if (!runtime.authenticated) throw new Error("Codex is not authenticated");
    return process.env.ROLEGAIN_COVER_MODEL ?? runtime.model;
  }
}
