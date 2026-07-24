import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { RolegainDependencies } from "../backend/control-flow/composition.js";
import { readJson, sendJson, setCors } from "./http.js";
import { serveStatic } from "./static-files.js";

type RouteDependencies = Pick<RolegainDependencies, "codex" | "jobSearch"> & {
  root: string;
};

export async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: RouteDependencies,
): Promise<void> {
  setCors(request, response);
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
    sendJson(response, 200, await dependencies.jobSearch.get());
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/job-search/background/stop"
  ) {
    const stopping = dependencies.jobSearch.stopBackgroundWork();
    await dependencies.codex.pauseAllTurns();
    sendJson(response, 200, await stopping);
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/job-search/background/continue"
  ) {
    dependencies.codex.resumeTurns();
    sendJson(
      response,
      202,
      await dependencies.jobSearch.continueBackgroundWork(),
    );
    return;
  }
  const candidateEvidenceMatch = pathname.match(
    /^\/api\/job-search\/candidates\/([a-z0-9-]+)\/evidence$/i,
  );
  if (request.method === "GET" && candidateEvidenceMatch) {
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
    const body = await readJson(request);
    sendJson(
      response,
      200,
      await dependencies.jobSearch.updateProfile(
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
          deferEvidenceAnalysis: body.deferEvidenceAnalysis === true,
        },
      ),
    );
    return;
  }
  if (request.method === "POST" && pathname === "/api/job-search/sources") {
    const body = await readJson(request);
    const workspace = await dependencies.jobSearch.addSource(body as never);
    sendJson(response, 202, workspace);
    if (body.deferAnalysis !== true)
      dependencies.jobSearch.queueCandidateAnalysis(workspace.candidateId);
    return;
  }
  const removeSourceMatch = pathname.match(
    /^\/api\/job-search\/sources\/([a-f0-9-]+)$/i,
  );
  if (request.method === "DELETE" && removeSourceMatch) {
    sendJson(
      response,
      200,
      await dependencies.jobSearch.removeSource(removeSourceMatch[1]),
    );
    return;
  }
  const stopSourceMatch = pathname.match(
    /^\/api\/job-search\/sources\/([a-f0-9-]+)\/stop$/i,
  );
  if (request.method === "POST" && stopSourceMatch) {
    sendJson(
      response,
      200,
      await dependencies.jobSearch.markSourceReadingStopped(stopSourceMatch[1]),
    );
    return;
  }
  if (request.method === "POST" && pathname === "/api/job-search/analyze") {
    sendJson(response, 200, await dependencies.jobSearch.analyzeCandidate());
    return;
  }
  const questionMatch = pathname.match(
    /^\/api\/job-search\/questions\/([a-z0-9-]+)$/i,
  );
  if (request.method === "POST" && questionMatch) {
    const body = await readJson(request);
    sendJson(
      response,
      200,
      await dependencies.jobSearch.answer(
        questionMatch[1],
        String(body.answer ?? ""),
      ),
    );
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/job-search/finish-intake"
  ) {
    sendJson(response, 200, await dependencies.jobSearch.finishIntake());
    return;
  }
  if (request.method === "POST" && pathname === "/api/job-search/prepare") {
    sendJson(
      response,
      200,
      await dependencies.jobSearch.startPrepareApplications(),
    );
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/job-search/prepare-ready"
  ) {
    sendJson(
      response,
      202,
      await dependencies.jobSearch.startPrepareSearchReadyApplications(),
    );
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/job-search/reset-jobs"
  ) {
    sendJson(response, 200, await dependencies.jobSearch.resetJobList());
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/job-search/reset-user"
  ) {
    sendJson(response, 200, await dependencies.jobSearch.resetUserCompletely());
    return;
  }
  if (request.method === "POST" && pathname === "/api/job-search/find-more") {
    sendJson(
      response,
      202,
      await dependencies.jobSearch.startFindMoreApplications(),
    );
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/job-search/search-config"
  ) {
    const body = await readJson(request);
    sendJson(
      response,
      200,
      await dependencies.jobSearch.updateSearchConfig({
        discoveryTarget: Number(body.discoveryTarget),
        applicationTarget: Number(body.applicationTarget),
      }),
    );
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/job-search/opportunities"
  ) {
    const body = await readJson(request);
    sendJson(
      response,
      201,
      await dependencies.jobSearch.addOpportunity(body as never),
    );
    return;
  }
  const promoteOpportunityMatch = pathname.match(
    /^\/api\/job-search\/opportunities\/([a-z0-9-]+)\/promote$/i,
  );
  if (request.method === "POST" && promoteOpportunityMatch) {
    sendJson(
      response,
      200,
      await dependencies.jobSearch.promoteOpportunity(
        promoteOpportunityMatch[1],
      ),
    );
    return;
  }
  const draftMatch = pathname.match(
    /^\/api\/job-search\/applications\/([a-z0-9-]+)$/i,
  );
  if (request.method === "POST" && draftMatch) {
    const body = await readJson(request);
    sendJson(
      response,
      200,
      await dependencies.jobSearch.updateApplication(
        draftMatch[1],
        body as never,
      ),
    );
    return;
  }
  const coverLetterChatMatch = pathname.match(
    /^\/api\/job-search\/applications\/([a-z0-9-]+)\/cover-letter-chat$/i,
  );
  if (request.method === "POST" && coverLetterChatMatch) {
    const body = await readJson(request);
    sendJson(
      response,
      200,
      await dependencies.jobSearch.refineCoverLetter(
        coverLetterChatMatch[1],
        String(body.message ?? ""),
      ),
    );
    return;
  }
  const fieldRefinementMatch = pathname.match(
    /^\/api\/job-search\/applications\/([a-z0-9-]+)\/fields\/([^/]+)\/refine$/i,
  );
  if (request.method === "POST" && fieldRefinementMatch) {
    const body = await readJson(request);
    sendJson(
      response,
      200,
      await dependencies.jobSearch.refineApplicationField(
        fieldRefinementMatch[1],
        decodeURIComponent(fieldRefinementMatch[2]),
        String(body.message ?? ""),
      ),
    );
    return;
  }
  const outcomeMatch = pathname.match(
    /^\/api\/job-search\/applications\/([a-z0-9-]+)\/outcome$/i,
  );
  if (request.method === "POST" && outcomeMatch) {
    const body = await readJson(request);
    const outcome =
      body.outcome === "rejected_by_user" ||
      body.outcome === "unsuccessful" ||
      body.outcome === "applied_waiting"
        ? body.outcome
        : undefined;
    sendJson(
      response,
      200,
      await dependencies.jobSearch.setApplicationOutcome(
        outcomeMatch[1],
        outcome,
      ),
    );
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
      await dependencies.jobSearch.autofillByUrl(target),
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
