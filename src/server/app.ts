import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRolegainDependencies,
  type RolegainDependencies,
} from "../backend/control-flow/composition.js";
import { proxyEmployerRequest } from "./employer-proxy.js";
import { sendJson } from "./http.js";
import { routeRequest } from "./job-search-routes.js";
import { CvValidationError } from "../01-evidence-ingestion/01-evidence-acquisition/cv/upload-cv.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..");

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
  const { root, codex, jobSearch } = dependencies;
  const applicationFormAutofillScript = await readFile(
    path.join(
      projectRoot,
      "src",
      "02-search",
      "browser",
      "application-form-autofill.js",
    ),
    "utf8",
  );

  const server = createServer(async (request, response) => {
    try {
      if (
        await proxyEmployerRequest(request, response, {
          applicationFormAutofillScript,
          isAllowedHost: (hostname) => jobSearch.isAllowedEmployerHost(hostname),
        })
      )
        return;
      await routeRequest(request, response, { codex, jobSearch, root });
    } catch (error) {
      const invalidCv = error instanceof CvValidationError;
      sendJson(response, invalidCv ? 422 : 500, {
        error: error instanceof Error ? error.message : String(error),
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
        server.listen(port, "127.0.0.1", () => {
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      }),
    close: async () => {
      await dependencies.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
