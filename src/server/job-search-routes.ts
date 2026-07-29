import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { RolegainDependencies } from "../backend/control-flow/composition.js";
import { readJson, sendJson, setCors } from "./http.js";
import { serveStatic } from "./static-files.js";
import type { AuthenticatedActor } from "./auth.js";
import {
  answerSchema,
  applicationUpdateSchema,
  messageSchema,
  opportunitySchema,
  outcomeSchema,
  profileSchema,
  searchConfigSchema,
  sourceSchema,
  validate,
} from "./validation.js";

type RouteDependencies = Pick<
  RolegainDependencies,
  | "codex"
  | "jobSearch"
  | "configuration"
  | "tokenCounter"
  | "workflows"
  | "artifacts"
  | "platform"
> & {
  root: string;
  actor?: AuthenticatedActor;
};

export async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: RouteDependencies,
): Promise<void> {
  setCors(
    request,
    response,
    dependencies.configuration.publicOrigin,
  );
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname);
  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true, service: "rolegain" });
    return;
  }
  if (!dependencies.actor) {
    if (pathname.startsWith("/api/"))
      throw new Error("Authenticated route has no actor");
    await serveStatic(
      pathname,
      response,
      path.join(dependencies.root, "dist", "client"),
    );
    return;
  }
  const userId = dependencies.actor.userId;
  if (request.method === "GET" && pathname === "/api/me") {
    sendJson(response, 200, {
      id: userId,
      email: dependencies.actor.email,
      name: dependencies.actor.name,
    });
    return;
  }
  if (request.method === "GET" && pathname === "/api/usage") {
    sendJson(response, 200, await dependencies.tokenCounter.get(userId));
    return;
  }
  if (request.method === "GET" && pathname === "/api/service-status") {
    sendJson(response, 200, await dependencies.platform.serviceStatus());
    return;
  }
  if (request.method === "GET" && pathname === "/api/beta") {
    sendJson(response, 200, await dependencies.platform.betaStatus(userId));
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/beta/release-updates"
  ) {
    sendJson(
      response,
      200,
      await dependencies.platform.enableReleaseUpdates(userId),
    );
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/analytics/events"
  ) {
    const body = await readJson(request);
    if (typeof body.name !== "string")
      throw new Error("Analytics event name is required");
    await dependencies.platform.recordEvent(userId, {
      name: body.name as never,
      metadata:
        body.metadata &&
        typeof body.metadata === "object" &&
        !Array.isArray(body.metadata)
          ? body.metadata as never
          : undefined,
    });
    sendJson(response, 202, { recorded: true });
    return;
  }
  if (
    request.method === "POST" &&
    codexRequiredPath(pathname)
  ) {
    await dependencies.platform.assertCodexEnabled();
    if (dependencies.configuration.authMode === "supabase")
      await dependencies.platform.assertLlmAllowance(userId);
  }
  if (
    request.method === "POST" &&
    dependencies.configuration.authMode === "supabase" &&
    (
      pathname === "/api/job-search/reset-user" ||
      pathname === "/api/job-search/reset-jobs"
    )
  )
    await dependencies.platform.assertLlmAllowance(userId);
  if (request.method === "GET" && pathname === "/api/workflows/latest") {
    sendJson(response, 200, (await dependencies.workflows?.latest(userId)) ?? null);
    return;
  }
  if (request.method === "GET" && pathname === "/api/runtime") {
    try {
      sendJson(response, 200, await dependencies.codex.start());
    } catch (error) {
      sendJson(response, 503, {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (request.method === "GET" && pathname === "/api/job-search") {
    let workspace = await dependencies.jobSearch.get(userId);
    if (
      (!workspace.profile.email && dependencies.actor.email) ||
      (!workspace.profile.name && dependencies.actor.name)
    )
      workspace = await dependencies.jobSearch.updateProfile(
        {
          email: workspace.profile.email || dependencies.actor.email,
          name: workspace.profile.name || dependencies.actor.name,
        },
        { deferEvidenceAnalysis: true },
        userId,
      );
    await dependencies.platform.recordApplications(
      userId,
      workspace.applications
        .filter((application) => Boolean(application.addedBy))
        .map((application) => application.id),
    );
    sendJson(response, 200, workspace);
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/job-search/background/stop"
  ) {
    if (dependencies.workflows) await dependencies.workflows.cancel(userId);
    else {
      const stopping = dependencies.jobSearch.stopBackgroundWork(userId);
      await dependencies.codex.pauseTurnsForUser(userId);
      await stopping;
    }
    sendJson(response, 200, await dependencies.jobSearch.get(userId));
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/job-search/background/continue"
  ) {
    dependencies.codex.resumeTurns();
    if (dependencies.workflows) {
      const before = await dependencies.jobSearch.get(userId);
      const control = before.backgroundExecution;
      const workspace = await dependencies.jobSearch.continueBackgroundWork(
        userId,
        false,
      );
      if (control?.resumeCandidateAnalysis || control?.resumeProfileSourceSync)
        await dependencies.workflows.enqueue(userId, "analyze");
      if (control?.resumeSearch)
        await dependencies.workflows.enqueue(
          userId,
          control.resumeSearch === "prepare_search_ready"
            ? "prepare-search-ready"
            : "prepare",
          { reserveBetaBatch: false },
        );
      sendJson(response, 202, workspace);
    } else
      sendJson(
        response,
        202,
        await dependencies.jobSearch.continueBackgroundWork(userId),
      );
    return;
  }
  const candidateEvidenceMatch = pathname.match(
    /^\/api\/job-search\/candidates\/([a-z0-9-]+)\/evidence$/i,
  );
  if (request.method === "GET" && candidateEvidenceMatch) {
    if (candidateEvidenceMatch[1] !== userId)
      throw new Error("Unknown candidate");
    sendJson(
      response,
      200,
      await dependencies.jobSearch.canonicalEvidence(candidateEvidenceMatch[1]),
    );
    return;
  }
  const sourceFileMatch = pathname.match(
    /^\/api\/job-search\/candidates\/([a-z0-9-]+)\/sources\/([a-f0-9-]+)\/file$/i,
  );
  if (request.method === "GET" && sourceFileMatch) {
    if (sourceFileMatch[1] !== userId) throw new Error("Unknown candidate");
    const original = await dependencies.jobSearch.sourceFile(
      sourceFileMatch[1],
      sourceFileMatch[2],
    );
    response.writeHead(200, {
      "Content-Type": original.mimeType,
      "Content-Length": original.size,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(original.name)}`,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(original.file).pipe(response);
    return;
  }
  if (request.method === "POST" && pathname === "/api/job-search/profile") {
    const body = validate(profileSchema, await readJson(request));
    let workspace = await dependencies.jobSearch.updateProfile(
        {
          name: typeof body.name === "string" ? body.name : undefined,
          email: typeof body.email === "string" ? body.email : undefined,
          phone: typeof body.phone === "string" ? body.phone : undefined,
          linkedin:
            typeof body.linkedin === "string" ? body.linkedin : undefined,
          github: typeof body.github === "string" ? body.github : undefined,
          website: typeof body.website === "string" ? body.website : undefined,
          location:
            typeof body.location === "string" ? body.location : undefined,
          workAuthorization:
            typeof body.workAuthorization === "string"
              ? body.workAuthorization
              : undefined,
        },
        {
          deferEvidenceAnalysis:
            dependencies.workflows ? true : body.deferEvidenceAnalysis === true,
        },
        userId,
      );
    if (
      dependencies.workflows &&
      workspace.sources.some(
        (source) => source.profileField && source.status === "processing",
      )
    ) {
      workspace = await dependencies.jobSearch.markWorkflowQueued(
        "analyze",
        userId,
      );
      await dependencies.workflows.enqueue(userId, "analyze");
    }
    sendJson(response, 200, workspace);
    return;
  }
  if (request.method === "POST" && pathname === "/api/job-search/sources") {
    const body = validate(sourceSchema, await readJson(request));
    const workspace = await dependencies.jobSearch.addSource(
      {
        ...body,
        deferAnalysis: dependencies.workflows ? true : body.deferAnalysis,
      } as never,
      userId,
    );
    await dependencies.artifacts.snapshot(userId);
    if (body.deferAnalysis !== true) {
      if (dependencies.workflows) {
        await dependencies.jobSearch.markWorkflowQueued("analyze", userId);
        await dependencies.workflows.enqueue(userId, "analyze");
      } else dependencies.jobSearch.queueCandidateAnalysis(workspace.candidateId);
    }
    sendJson(response, 202, await dependencies.jobSearch.get(userId));
    return;
  }
  const removeSourceMatch = pathname.match(
    /^\/api\/job-search\/sources\/([a-f0-9-]+)$/i,
  );
  if (request.method === "DELETE" && removeSourceMatch) {
    const workspace = await dependencies.jobSearch.removeSource(
      removeSourceMatch[1],
      userId,
    );
    await dependencies.artifacts.snapshot(userId);
    sendJson(response, 200, workspace);
    return;
  }
  const stopSourceMatch = pathname.match(
    /^\/api\/job-search\/sources\/([a-f0-9-]+)\/stop$/i,
  );
  if (request.method === "POST" && stopSourceMatch) {
    sendJson(
      response,
      200,
      await dependencies.jobSearch.markSourceReadingStopped(
        stopSourceMatch[1],
        userId,
      ),
    );
    return;
  }
  if (request.method === "POST" && pathname === "/api/job-search/analyze") {
    if (dependencies.workflows) {
      const workspace = await dependencies.jobSearch.markWorkflowQueued(
        "analyze",
        userId,
      );
      await dependencies.workflows.enqueue(userId, "analyze");
      sendJson(response, 202, workspace);
    } else
      sendJson(
        response,
        200,
        await dependencies.jobSearch.analyzeCandidate(userId),
      );
    return;
  }
  const questionMatch = pathname.match(
    /^\/api\/job-search\/questions\/([a-z0-9-]+)$/i,
  );
  if (request.method === "POST" && questionMatch) {
    const body = validate(answerSchema, await readJson(request));
    sendJson(
      response,
      200,
      await dependencies.jobSearch.answer(
        questionMatch[1],
        body.answer,
        userId,
      ),
    );
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/job-search/finish-intake"
  ) {
    sendJson(
      response,
      200,
      await dependencies.jobSearch.finishIntake(userId),
    );
    return;
  }
  if (request.method === "POST" && pathname === "/api/job-search/prepare") {
    if (dependencies.workflows) {
      const workspace = await dependencies.jobSearch.markWorkflowQueued(
        "prepare",
        userId,
      );
      await dependencies.workflows.enqueue(userId, "prepare");
      sendJson(response, 202, workspace);
    } else
      {
        const beta =
          dependencies.configuration.authMode === "supabase"
            ? await dependencies.platform.reserveBatch(userId)
            : await dependencies.platform.betaStatus(userId);
        sendJson(
          response,
          200,
          await dependencies.jobSearch.startPrepareApplications(
            dependencies.configuration.authMode === "supabase"
              ? Math.min(5, beta.remainingApplications)
              : 5,
            false,
            userId,
          ),
        );
      }
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/job-search/prepare-ready"
  ) {
    if (dependencies.workflows) {
      const workspace = await dependencies.jobSearch.markWorkflowQueued(
        "prepare-search-ready",
        userId,
      );
      await dependencies.workflows.enqueue(userId, "prepare-search-ready");
      sendJson(response, 202, workspace);
    } else
      {
        const beta =
          dependencies.configuration.authMode === "supabase"
            ? await dependencies.platform.reserveBatch(userId)
            : await dependencies.platform.betaStatus(userId);
        sendJson(
          response,
          202,
          await dependencies.jobSearch.startPrepareSearchReadyApplications(
            userId,
            dependencies.configuration.authMode === "supabase"
              ? Math.min(5, beta.remainingApplications)
              : 5,
          ),
        );
      }
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/job-search/reset-jobs"
  ) {
    sendJson(
      response,
      200,
      await dependencies.jobSearch.resetJobList(userId),
    );
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/job-search/reset-user"
  ) {
    const workspace = await dependencies.jobSearch.resetUserCompletely(userId);
    await dependencies.artifacts.delete(userId);
    sendJson(response, 200, workspace);
    return;
  }
  if (request.method === "POST" && pathname === "/api/job-search/find-more") {
    if (dependencies.workflows) {
      const workspace = await dependencies.jobSearch.markWorkflowQueued(
        "find-more",
        userId,
      );
      await dependencies.workflows.enqueue(userId, "find-more");
      sendJson(response, 202, workspace);
    } else
      {
        const beta =
          dependencies.configuration.authMode === "supabase"
            ? await dependencies.platform.reserveBatch(userId)
            : await dependencies.platform.betaStatus(userId);
        sendJson(
          response,
          202,
          await dependencies.jobSearch.startPrepareApplications(
            dependencies.configuration.authMode === "supabase"
              ? Math.min(5, beta.remainingApplications)
              : 5,
            true,
            userId,
          ),
        );
      }
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/job-search/search-config"
  ) {
    const body = validate(searchConfigSchema, await readJson(request));
    sendJson(
      response,
      200,
      await dependencies.jobSearch.updateSearchConfig({
        discoveryTarget: body.discoveryTarget,
        applicationTarget:
          dependencies.configuration.authMode === "supabase"
            ? 5
            : body.applicationTarget,
      }, userId),
    );
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/job-search/opportunities"
  ) {
    if (dependencies.configuration.authMode === "supabase")
      await dependencies.platform.assertApplicationAvailable(userId);
    const body = validate(opportunitySchema, await readJson(request));
    const workspace = await dependencies.jobSearch.addOpportunity(
      body as never,
      userId,
    );
    await dependencies.platform.recordApplications(
      userId,
      workspace.applications
        .filter((application) => Boolean(application.addedBy))
        .map((application) => application.id),
    );
    sendJson(
      response,
      201,
      workspace,
    );
    return;
  }
  const promoteOpportunityMatch = pathname.match(
    /^\/api\/job-search\/opportunities\/([a-z0-9-]+)\/promote$/i,
  );
  if (request.method === "POST" && promoteOpportunityMatch) {
    if (dependencies.configuration.authMode === "supabase")
      await dependencies.platform.assertApplicationAvailable(userId);
    const workspace = await dependencies.jobSearch.promoteOpportunity(
      promoteOpportunityMatch[1],
      userId,
    );
    await dependencies.platform.recordApplications(
      userId,
      workspace.applications
        .filter((application) => Boolean(application.addedBy))
        .map((application) => application.id),
    );
    sendJson(
      response,
      200,
      workspace,
    );
    return;
  }
  const draftMatch = pathname.match(
    /^\/api\/job-search\/applications\/([a-z0-9-]+)$/i,
  );
  if (request.method === "POST" && draftMatch) {
    const body = validate(applicationUpdateSchema, await readJson(request));
    sendJson(
      response,
      200,
      await dependencies.jobSearch.updateApplication(
        draftMatch[1],
        body as never,
        userId,
      ),
    );
    return;
  }
  const tailoredCvMatch = pathname.match(
    /^\/api\/job-search\/applications\/([a-z0-9-]+)\/tailored-cv$/i,
  );
  if (request.method === "POST" && tailoredCvMatch) {
    await dependencies.platform.recordEvent(userId, {
      name: "tailored_cv_requested",
      metadata: { applicationId: tailoredCvMatch[1] },
    });
    if (dependencies.workflows) {
      const workspace = await dependencies.jobSearch.markWorkflowQueued(
        "tailor-cv",
        userId,
        tailoredCvMatch[1],
      );
      await dependencies.workflows.enqueue(userId, "tailor-cv", {
        resourceId: tailoredCvMatch[1],
      });
      sendJson(response, 202, workspace);
    } else
      sendJson(
        response,
        200,
        await dependencies.jobSearch.tailorApplicationCv(
          tailoredCvMatch[1],
          userId,
        ),
      );
    return;
  }
  if (request.method === "GET" && tailoredCvMatch) {
    const document = await dependencies.jobSearch.tailoredCvFile(
      userId,
      tailoredCvMatch[1],
    );
    response.writeHead(200, {
      "Content-Type": document.mimeType,
      "Content-Length": document.size,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(document.file).pipe(response);
    return;
  }
  const coverLetterChatMatch = pathname.match(
    /^\/api\/job-search\/applications\/([a-z0-9-]+)\/cover-letter-chat$/i,
  );
  if (request.method === "POST" && coverLetterChatMatch) {
    const body = validate(messageSchema, await readJson(request));
    sendJson(
      response,
      200,
      await dependencies.jobSearch.refineCoverLetter(
        coverLetterChatMatch[1],
        body.message,
        userId,
      ),
    );
    return;
  }
  const fieldRefinementMatch = pathname.match(
    /^\/api\/job-search\/applications\/([a-z0-9-]+)\/fields\/([^/]+)\/refine$/i,
  );
  if (request.method === "POST" && fieldRefinementMatch) {
    const body = validate(messageSchema, await readJson(request));
    sendJson(
      response,
      200,
      await dependencies.jobSearch.refineApplicationField(
        fieldRefinementMatch[1],
        decodeURIComponent(fieldRefinementMatch[2]),
        body.message,
        userId,
      ),
    );
    return;
  }
  const outcomeMatch = pathname.match(
    /^\/api\/job-search\/applications\/([a-z0-9-]+)\/outcome$/i,
  );
  if (request.method === "POST" && outcomeMatch) {
    const body = validate(outcomeSchema, await readJson(request));
    const outcome =
      body.outcome === "rejected_by_user" ||
      body.outcome === "unsuccessful" ||
      body.outcome === "applied_waiting"
        ? body.outcome
        : undefined;
    const workspace = await dependencies.jobSearch.setApplicationOutcome(
      outcomeMatch[1],
      outcome,
      userId,
    );
    if (outcome === "applied_waiting")
      await dependencies.platform.recordEvent(userId, {
        name: "application_marked_applied",
        metadata: { applicationId: outcomeMatch[1] },
      });
    sendJson(response, 200, workspace);
    return;
  }
  if (
    request.method === "GET" &&
    pathname === "/api/job-search/employer-form/autofill"
  ) {
    const target = url.searchParams.get("url") ?? "";
    sendJson(
      response,
      200,
      await dependencies.jobSearch.autofillByUrl(target, userId),
    );
    return;
  }

  if (request.method === "GET" && pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  await serveStatic(
    pathname,
    response,
    path.join(dependencies.root, "dist", "client"),
  );
}

function codexRequiredPath(pathname: string) {
  return (
    pathname === "/api/job-search/profile" ||
    pathname === "/api/job-search/sources" ||
    pathname === "/api/job-search/analyze" ||
    pathname === "/api/job-search/prepare" ||
    pathname === "/api/job-search/prepare-ready" ||
    pathname === "/api/job-search/find-more" ||
    pathname === "/api/job-search/background/continue" ||
    pathname === "/api/job-search/opportunities" ||
    /^\/api\/job-search\/opportunities\/[^/]+\/promote$/i.test(pathname) ||
    /^\/api\/job-search\/applications\/[^/]+\/tailored-cv$/i.test(pathname) ||
    /^\/api\/job-search\/applications\/[^/]+\/cover-letter-chat$/i.test(pathname) ||
    /^\/api\/job-search\/applications\/[^/]+\/fields\/[^/]+\/refine$/i.test(pathname)
  );
}
