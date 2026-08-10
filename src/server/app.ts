import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import {
  createRolegainDependencies,
  type RolegainDependencies,
} from "../backend/control-flow/composition.js";
import { proxyEmployerRequest } from "./employer-proxy.js";
import { sendJson } from "./http.js";
import { routeRequest } from "./job-search-routes.js";
import { CvValidationError } from "../01-evidence-ingestion/01-evidence-acquisition/cv/upload-cv.js";
import {
  createRequestAuthenticator,
  createUserAccountAdmin,
  HttpError,
} from "./auth.js";
import { ApiRateLimiter } from "./rate-limit.js";
import { withUserLock } from "../infrastructure/database.js";
import { AdminRoutes } from "./admin-routes.js";
import { appendDiagnosticEvent } from "../diagnostics/run-log.js";

const projectRoot = process.cwd();

export interface RolegainApp {
  codex: RolegainDependencies["codex"];
  jobSearch: RolegainDependencies["jobSearch"];
  server: ReturnType<typeof createServer>;
  start: (port?: number) => Promise<number>;
  close: () => Promise<void>;
}

export async function createRolegainApp(
  options: { rootDir?: string; dataRoot?: string } = {},
): Promise<RolegainApp> {
  const dependencies = await createRolegainDependencies(options);
  const { root, codex, jobSearch, configuration } = dependencies;
  const authenticator = createRequestAuthenticator(configuration);
  const rateLimiter = new ApiRateLimiter();
  const accountAdmin = createUserAccountAdmin(configuration);
  const adminRoutes = new AdminRoutes(
    configuration,
    dependencies.platform,
    dependencies.workflows,
    {
      jobSearch: dependencies.jobSearch,
      artifacts: dependencies.artifacts,
      accounts: accountAdmin,
      lockPool: dependencies.sessionDatabase,
    },
  );
  const restoredUsers = new Set<string>();
  const applicationFormAutofillScript = await readFile(
    path.join(
      projectRoot,
      "src",
      "02-search",
      "v1",
      "browser",
      "application-form-autofill.js",
    ),
    "utf8",
  );

  const server = createServer(async (request, response) => {
    const requestStartedAt = Date.now();
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    response.once("finish", () => {
      void appendDiagnosticEvent("http-request", {
        method: request.method,
        pathname: requestUrl.pathname,
        query: requestUrl.search,
        statusCode: response.statusCode,
        durationMs: Date.now() - requestStartedAt,
      });
    });
    try {
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
      response.setHeader("X-Frame-Options", "DENY");
      response.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=()",
      );
      if (configuration.authMode === "supabase") {
        const supabaseOrigin = new URL(configuration.supabaseUrl!).origin;
        response.setHeader(
          "Content-Security-Policy",
          `default-src 'self'; connect-src 'self' ${supabaseOrigin} ${supabaseOrigin.replace("https:", "wss:")}; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
        );
        response.setHeader(
          "Strict-Transport-Security",
          "max-age=31536000; includeSubDomains",
        );
      }
      if (
        configuration.authMode === "local" &&
        await proxyEmployerRequest(request, response, {
          applicationFormAutofillScript,
          isAllowedHost: (hostname) => jobSearch.isAllowedEmployerHost(hostname),
        })
      )
        return;
      const pathname = new URL(
        request.url ?? "/",
        "http://127.0.0.1",
      ).pathname;
      if (adminRoutes.matches(pathname)) {
        await adminRoutes.route(request, response, pathname);
        return;
      }
      const actor =
        pathname === "/api/health" ||
        request.method === "OPTIONS" ||
        !pathname.startsWith("/api/")
          ? undefined
          : await authenticator.authenticate(request);
      if (actor && !restoredUsers.has(actor.userId)) {
        await dependencies.artifacts.restore(actor.userId);
        restoredUsers.add(actor.userId);
      }
      if (actor) rateLimiter.enforce(request, actor);
      const route = () =>
        routeRequest(request, response, {
          ...dependencies,
          actor,
          root,
        });
      if (actor) {
        const runAuthenticatedRoute = () =>
          codex.runWithExecutionContext({ userId: actor.userId }, route);
        if (
          dependencies.database &&
          request.method !== "GET" &&
          request.method !== "HEAD" &&
          pathname !== "/api/job-search/background/stop" &&
          pathname !== "/api/job-search/reset-user"
        )
          await withUserLock(
            dependencies.sessionDatabase || dependencies.database,
            actor.userId,
            () => runAuthenticatedRoute(),
          );
        else await runAuthenticatedRoute();
      } else await route();
    } catch (error) {
      const invalidCv = error instanceof CvValidationError;
      const httpError = error instanceof HttpError ? error : undefined;
      sendJson(response, httpError?.status ?? (invalidCv ? 422 : 500), {
        error: error instanceof Error ? error.message : String(error),
        ...(httpError?.code ? { code: httpError.code } : {}),
        ...(invalidCv ? { code: error.code } : {}),
      });
    }
  });

  return {
    codex,
    jobSearch,
    server,
    start: (port = Number(process.env.PORT || 4317)) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(
          port,
          process.env.HOST ||
            (configuration.authMode === "supabase" ? "0.0.0.0" : "127.0.0.1"),
          () => {
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
          },
        );
      }),
    close: async () => {
      await dependencies.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
